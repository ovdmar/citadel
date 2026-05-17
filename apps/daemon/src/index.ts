import { defaultConfigPath, loadConfig } from "@citadel/config";
import { SqliteStore } from "@citadel/db";
import { OperationService } from "@citadel/operations";
import { createDaemonApp } from "./app.js";

const configPath = defaultConfigPath();
const config = loadConfig(configPath);
const store = new SqliteStore(config.databasePath);
store.migrate();
const operations = new OperationService(store, config);
const { server } = createDaemonApp({ config, configPath, store, operations });

server.listen(config.port, config.bindHost, () => {
  console.log(`Citadel daemon listening on http://${config.bindHost}:${config.port}`);
});
