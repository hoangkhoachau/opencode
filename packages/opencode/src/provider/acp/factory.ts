import type { LanguageModelV2 } from "@ai-sdk/provider"
import { ACPLanguageModel } from "./model"
import { ACPConnectionPool, type PoolConfig } from "./pool"
import type { ACPProviderConfig } from "./types"
import { Log } from "../../util/log"

const log = Log.create({ service: "acp-factory" })

/**
 * Create ACP provider models from configuration
 */
export function createACPProvider(
  providerID: string,
  config: ACPProviderConfig & { pool?: Partial<PoolConfig> },
): Record<string, LanguageModelV2> {
  using _ = log.time("createACPProvider", { providerID })

  // Configure connection pool if options are provided
  if (config.pool) {
    const pool = ACPConnectionPool.getInstance()
    pool.setConfig(config.pool)
    log.info("Pool configuration applied", { poolConfig: config.pool })
  }

  const models: Record<string, LanguageModelV2> = {}

  for (const [modelID, modelConfig] of Object.entries(config.models)) {
    log.info("Creating ACP model", {
      providerID,
      modelID,
      command: config.command,
      args: config.args,
    })

    models[modelID] = new ACPLanguageModel({
      modelId: modelConfig.id,
      command: config.command,
      args: config.args,
      maxTokens: modelConfig.maxTokens,
    })
  }

  return models
}
