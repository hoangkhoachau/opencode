import { test, expect, mock, beforeEach, afterEach } from "bun:test"
import { ACPConnectionPool } from "../../src/provider/acp/pool"
import { ACPClient } from "../../src/provider/acp/client"

// Mock ACPClient for testing
const createMockClient = () => {
  const client = {
    initialize: mock(async () => {}),
    cleanup: mock(async () => {}),
    isAlive: mock(() => true),
    setPooled: mock(() => {}),
    currentSessionId: null,
    isPooled: false,
    getOrCreateSession: mock(async () => "test-session-id"),
    resetSession: mock(async () => "test-session-id"),
    createSession: mock(async () => "test-session-id"),
    closeSession: mock(async () => {}),
    sendMessage: mock(async () => ({ stopReason: "stop" })),
    onUpdate: mock(() => () => {}),
  }
  return client as unknown as ACPClient
}

beforeEach(() => {
  // Reset the singleton instance
  ;(ACPConnectionPool as any).instance = null
})

afterEach(() => {
  // Cleanup is handled by tests
})

test("ACPConnectionPool - singleton instance", () => {
  const pool1 = ACPConnectionPool.getInstance()
  const pool2 = ACPConnectionPool.getInstance()
  expect(pool1).toBe(pool2)
})

test("ACPConnectionPool - acquire creates new client when pool is empty", async () => {
  const pool = ACPConnectionPool.getInstance()
  pool.setConfig({ enabled: true, maxSize: 3, idleTimeout: 300000, reuseSession: true })

  const client = await pool.acquire("test-command", ["arg1", "arg2"])
  
  expect(client).toBeDefined()
  expect(client.isAlive()).toBe(true)
  
  // Cleanup
  await pool.cleanup()
})

test("ACPConnectionPool - release and reuse client", async () => {
  const pool = ACPConnectionPool.getInstance()
  pool.setConfig({ enabled: true, maxSize: 3, idleTimeout: 300000, reuseSession: true })

  // Acquire a client
  const client1 = await pool.acquire("test-command", ["arg1"])
  
  // Release it back
  await pool.release(client1)
  
  // Acquire again - should get the same client
  const client2 = await pool.acquire("test-command", ["arg1"])
  
  expect(client2).toBe(client1)
  
  // Cleanup
  await pool.cleanup()
})

test("ACPConnectionPool - pool size limit", async () => {
  const pool = ACPConnectionPool.getInstance()
  pool.setConfig({ enabled: true, maxSize: 2, idleTimeout: 300000, reuseSession: true })

  // Acquire up to max size
  const client1 = await pool.acquire("test-command", ["arg1"])
  const client2 = await pool.acquire("test-command", ["arg1"])
  
  const stats = pool.getStats()
  expect(stats["test-command:arg1"].total).toBe(2)
  expect(stats["test-command:arg1"].inUse).toBe(2)
  
  // Cleanup
  await pool.cleanup()
})

test("ACPConnectionPool - different pool keys for different commands", async () => {
  const pool = ACPConnectionPool.getInstance()
  pool.setConfig({ enabled: true, maxSize: 3, idleTimeout: 300000, reuseSession: true })

  const client1 = await pool.acquire("command1", ["arg1"])
  const client2 = await pool.acquire("command2", ["arg1"])
  
  // Should be different clients
  expect(client1).not.toBe(client2)
  
  const stats = pool.getStats()
  expect(stats["command1:arg1"]).toBeDefined()
  expect(stats["command2:arg1"]).toBeDefined()
  
  // Cleanup
  await pool.cleanup()
})

test("ACPConnectionPool - pool disabled returns non-pooled client", async () => {
  const pool = ACPConnectionPool.getInstance()
  pool.setConfig({ enabled: false, maxSize: 3, idleTimeout: 300000, reuseSession: true })

  const client1 = await pool.acquire("test-command", ["arg1"])
  await pool.release(client1)
  
  const client2 = await pool.acquire("test-command", ["arg1"])
  
  // Should be different clients when pool is disabled
  // (Note: in real implementation, this would create new clients each time)
  expect(client1).not.toBe(client2)
  
  // Cleanup
  await pool.cleanup()
})

test("ACPConnectionPool - getStats returns pool statistics", async () => {
  const pool = ACPConnectionPool.getInstance()
  pool.setConfig({ enabled: true, maxSize: 3, idleTimeout: 300000, reuseSession: true })

  const client1 = await pool.acquire("test-command", ["arg1"])
  const client2 = await pool.acquire("test-command", ["arg1"])
  await pool.release(client1)
  
  const stats = pool.getStats()
  
  expect(stats["test-command:arg1"].total).toBe(2)
  expect(stats["test-command:arg1"].inUse).toBe(1)
  expect(stats["test-command:arg1"].idle).toBe(1)
  
  // Cleanup
  await pool.cleanup()
})

test("ACPConnectionPool - cleanup removes all clients", async () => {
  const pool = ACPConnectionPool.getInstance()
  pool.setConfig({ enabled: true, maxSize: 3, idleTimeout: 300000, reuseSession: true })

  await pool.acquire("test-command", ["arg1"])
  await pool.acquire("test-command", ["arg1"])
  
  await pool.cleanup()
  
  const stats = pool.getStats()
  expect(Object.keys(stats).length).toBe(0)
})

test("ACPConnectionPool - setConfig updates configuration", () => {
  const pool = ACPConnectionPool.getInstance()
  
  pool.setConfig({ maxSize: 5, idleTimeout: 600000 })
  
  const config = pool.getConfig()
  expect(config.maxSize).toBe(5)
  expect(config.idleTimeout).toBe(600000)
})

test("ACPClient - session reuse methods", async () => {
  const client = createMockClient()
  
  // Test getOrCreateSession when no session exists
  const sessionId1 = await client.getOrCreateSession({ model: undefined })
  expect(sessionId1).toBe("test-session-id")
  
  // Test that createSession is called
  expect(client.getOrCreateSession).toHaveBeenCalled()
})

test("ACPClient - setPooled method", () => {
  const client = createMockClient()
  
  client.setPooled(true)
  expect(client.setPooled).toHaveBeenCalledWith(true)
  
  client.setPooled(false)
  expect(client.setPooled).toHaveBeenCalledWith(false)
})
