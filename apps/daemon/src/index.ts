import { defaultConfigPath, loadConfig } from "@citadel/config";
import { SqliteStore } from "@citadel/db";
import { OperationService } from "@citadel/operations";
import { createDaemonApp } from "./app.js";

const configPath = defaultConfigPath();
const config = loadConfig(configPath);
const portOverride = Number.parseInt(process.env.CITADEL_PORT ?? "", 10);
if (Number.isFinite(portOverride) && portOverride > 0 && portOverride < 65536) config.port = portOverride;
if (process.env.CITADEL_BIND_HOST) config.bindHost = process.env.CITADEL_BIND_HOST;
const store = new SqliteStore(config.databasePath);
store.migrate();
const operations = new OperationService(store, config);
const { server } = createDaemonApp({ config, configPath, store, operations });

server.listen(config.port, config.bindHost, () => {
  console.log(`Citadel daemon listening on http://${config.bindHost}:${config.port}`);
});
