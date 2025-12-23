import { ACPClient, type SessionConfig } from "./client"
import type { Agent } from "../../agent/agent"
import { Log } from "../../util/log"
import { Config } from "../../config/config"

const log = Log.create({ service: "acp-pool" })

export interface PoolConfig {
  enabled: boolean
  maxSize: number
  idleTimeout: number
  reuseSession: boolean
}

interface PoolEntry {
  client: ACPClient
  inUse: boolean
  lastUsed: number
  sessionId: string | null
  poolKey: string
}

/**
 * ACPConnectionPool manages a pool of ACPClient instances for performance
 */
export class ACPConnectionPool {
  private static instance: ACPConnectionPool | null = null
  private pools: Map<string, PoolEntry[]> = new Map()
  private config: PoolConfig = {
    enabled: true,
    maxSize: 3,
    idleTimeout: 300000, // 5 minutes
    reuseSession: true,
  }
  private cleanupInterval: Timer | null = null

  private constructor() {
    this.startIdleCleanup()
    this.registerShutdownHandlers()
  }

  /**
   * Get the singleton instance of the connection pool
   */
  static getInstance(): ACPConnectionPool {
    if (!ACPConnectionPool.instance) {
      ACPConnectionPool.instance = new ACPConnectionPool()
    }
    return ACPConnectionPool.instance
  }

  /**
   * Update pool configuration
   */
  setConfig(config: Partial<PoolConfig>): void {
    this.config = { ...this.config, ...config }
    log.info("Pool config updated", { config: this.config })
  }

  /**
   * Get pool configuration
   */
  getConfig(): PoolConfig {
    return { ...this.config }
  }

  /**
   * Generate a unique key for a pool based on command and args
   */
  private getPoolKey(command: string, args: string[]): string {
    return `${command}:${args.join(":")}`
  }

  /**
   * Acquire a client from the pool
   */
  async acquire(
    command: string,
    args: string[],
    permission?: Agent.Info["permission"],
    sessionContext?: { sessionID: string; messageID: string; agentName: string },
  ): Promise<ACPClient> {
    using _ = log.time("acquire", { command })

    if (!this.config.enabled) {
      // Pool disabled, create new client
      log.debug("Pool disabled, creating new client")
      const client = new ACPClient(command, args, permission, sessionContext)
      await client.initialize()
      return client
    }

    const poolKey = this.getPoolKey(command, args)
    let pool = this.pools.get(poolKey)

    if (!pool) {
      pool = []
      this.pools.set(poolKey, pool)
    }

    // Try to find an available healthy client
    for (const entry of pool) {
      if (!entry.inUse && this.isHealthy(entry.client)) {
        entry.inUse = true
        entry.lastUsed = Date.now()
        log.info("Reusing pooled client", { poolKey, poolSize: pool.length })
        return entry.client
      }
    }

    // No available client and pool not full, create new one
    if (pool.length < this.config.maxSize) {
      log.info("Creating new pooled client", { poolKey, currentSize: pool.length, maxSize: this.config.maxSize })
      const client = await this.createClient(command, args, permission, sessionContext)
      const entry: PoolEntry = {
        client,
        inUse: true,
        lastUsed: Date.now(),
        sessionId: null,
        poolKey,
      }
      pool.push(entry)
      return client
    }

    // Pool is full, wait for a client to become available
    log.info("Pool full, waiting for available client", { poolKey, poolSize: pool.length })
    return await this.waitForAvailableClient(poolKey, command, args, permission, sessionContext)
  }

  /**
   * Wait for a client to become available in the pool
   */
  private async waitForAvailableClient(
    poolKey: string,
    command: string,
    args: string[],
    permission?: Agent.Info["permission"],
    sessionContext?: { sessionID: string; messageID: string; agentName: string },
  ): Promise<ACPClient> {
    const maxWaitTime = 30000 // 30 seconds
    const checkInterval = 100 // 100ms
    const startTime = Date.now()

    while (Date.now() - startTime < maxWaitTime) {
      const pool = this.pools.get(poolKey)
      if (pool) {
        // Check for available client
        for (const entry of pool) {
          if (!entry.inUse && this.isHealthy(entry.client)) {
            entry.inUse = true
            entry.lastUsed = Date.now()
            log.info("Acquired client after waiting", { poolKey, waitTime: Date.now() - startTime })
            return entry.client
          }
        }
      }

      // Wait a bit before checking again
      await new Promise((resolve) => setTimeout(resolve, checkInterval))
    }

    // Timeout reached, create a new client anyway (exceeds max size temporarily)
    log.warn("Pool wait timeout, creating new client beyond max size", { poolKey })
    const client = await this.createClient(command, args, permission, sessionContext)
    const pool = this.pools.get(poolKey) || []
    const entry: PoolEntry = {
      client,
      inUse: true,
      lastUsed: Date.now(),
      sessionId: null,
      poolKey,
    }
    pool.push(entry)
    this.pools.set(poolKey, pool)
    return client
  }

  /**
   * Release a client back to the pool
   */
  async release(client: ACPClient): Promise<void> {
    using _ = log.time("release")

    if (!this.config.enabled) {
      // Pool disabled, cleanup the client
      await client.cleanup()
      return
    }

    // Find the client in all pools
    for (const [poolKey, pool] of this.pools.entries()) {
      const entry = pool.find((e) => e.client === client)
      if (entry) {
        if (!this.isHealthy(client)) {
          log.warn("Releasing unhealthy client, removing from pool", { poolKey })
          await this.removeEntry(poolKey, entry)
        } else {
          entry.inUse = false
          entry.lastUsed = Date.now()
          log.info("Client released back to pool", { poolKey })
        }
        return
      }
    }

    // Client not found in pool (e.g., pool was disabled), clean it up
    log.debug("Released client not in pool, cleaning up")
    await client.cleanup()
  }

  /**
   * Remove an entry from the pool and cleanup the client
   */
  private async removeEntry(poolKey: string, entry: PoolEntry): Promise<void> {
    const pool = this.pools.get(poolKey)
    if (!pool) return

    const index = pool.indexOf(entry)
    if (index !== -1) {
      pool.splice(index, 1)
    }

    try {
      await entry.client.cleanup()
    } catch (error) {
      log.error("Error cleaning up client", { error })
    }

    if (pool.length === 0) {
      this.pools.delete(poolKey)
    }
  }

  /**
   * Create a new ACPClient instance
   */
  private async createClient(
    command: string,
    args: string[],
    permission?: Agent.Info["permission"],
    sessionContext?: { sessionID: string; messageID: string; agentName: string },
  ): Promise<ACPClient> {
    const client = new ACPClient(command, args, permission, sessionContext)
    client.setPooled(true)
    await client.initialize()
    return client
  }

  /**
   * Check if a client is healthy (subprocess still alive)
   */
  private isHealthy(client: ACPClient): boolean {
    return client.isAlive()
  }

  /**
   * Start the idle cleanup timer
   */
  private startIdleCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
    }

    // Run cleanup every minute
    this.cleanupInterval = setInterval(() => {
      this.cleanupIdleConnections()
    }, 60000)
  }

  /**
   * Clean up idle connections that have exceeded the timeout
   */
  private async cleanupIdleConnections(): Promise<void> {
    const now = Date.now()
    const entriesToRemove: Array<{ poolKey: string; entry: PoolEntry }> = []

    for (const [poolKey, pool] of this.pools.entries()) {
      for (const entry of pool) {
        if (!entry.inUse && now - entry.lastUsed > this.config.idleTimeout) {
          log.info("Cleaning up idle connection", { poolKey, idleTime: now - entry.lastUsed })
          entriesToRemove.push({ poolKey, entry })
        }
      }
    }

    // Remove idle entries
    for (const { poolKey, entry } of entriesToRemove) {
      await this.removeEntry(poolKey, entry)
    }
  }

  /**
   * Cleanup all connections in the pool
   */
  async cleanup(): Promise<void> {
    using _ = log.time("cleanup")

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }

    const cleanupPromises: Promise<void>[] = []

    for (const [poolKey, pool] of this.pools.entries()) {
      log.info("Cleaning up pool", { poolKey, size: pool.length })
      for (const entry of pool) {
        cleanupPromises.push(
          entry.client.cleanup().catch((error) => {
            log.error("Error cleaning up client in pool", { error, poolKey })
          }),
        )
      }
    }

    await Promise.all(cleanupPromises)
    this.pools.clear()
    log.info("All pools cleaned up")
  }

  /**
   * Register shutdown handlers for graceful cleanup
   */
  private registerShutdownHandlers(): void {
    const handleShutdown = () => {
      log.info("Shutdown signal received, cleaning up pools")
      this.cleanup()
        .then(() => {
          log.info("Pool cleanup completed")
        })
        .catch((error) => {
          log.error("Error during pool cleanup", { error })
        })
    }

    process.on("SIGINT", handleShutdown)
    process.on("SIGTERM", handleShutdown)
    process.on("exit", handleShutdown)
  }

  /**
   * Get statistics about the pool
   */
  getStats(): Record<string, { total: number; inUse: number; idle: number }> {
    const stats: Record<string, { total: number; inUse: number; idle: number }> = {}

    for (const [poolKey, pool] of this.pools.entries()) {
      const inUse = pool.filter((e) => e.inUse).length
      stats[poolKey] = {
        total: pool.length,
        inUse,
        idle: pool.length - inUse,
      }
    }

    return stats
  }
}
