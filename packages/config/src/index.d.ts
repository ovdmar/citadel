import type { z } from "zod";
export declare const RuntimeConfigSchema: z.ZodObject<
  {
    id: z.ZodString;
    displayName: z.ZodString;
    command: z.ZodString;
    args: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
  },
  "strip",
  z.ZodTypeAny,
  {
    id: string;
    displayName: string;
    command: string;
    args: string[];
  },
  {
    id: string;
    displayName: string;
    command: string;
    args?: string[] | undefined;
  }
>;
export declare const CitadelConfigSchema: z.ZodObject<
  {
    version: z.ZodDefault<z.ZodLiteral<1>>;
    dataDir: z.ZodString;
    databasePath: z.ZodString;
    bindHost: z.ZodDefault<z.ZodString>;
    port: z.ZodDefault<z.ZodNumber>;
    mcp: z.ZodDefault<
      z.ZodObject<
        {
          enabled: z.ZodDefault<z.ZodBoolean>;
        },
        "strip",
        z.ZodTypeAny,
        {
          enabled: boolean;
        },
        {
          enabled?: boolean | undefined;
        }
      >
    >;
    providers: z.ZodDefault<
      z.ZodObject<
        {
          github: z.ZodDefault<
            z.ZodObject<
              {
                enabled: z.ZodDefault<z.ZodBoolean>;
              },
              "strip",
              z.ZodTypeAny,
              {
                enabled: boolean;
              },
              {
                enabled?: boolean | undefined;
              }
            >
          >;
          jira: z.ZodDefault<
            z.ZodObject<
              {
                enabled: z.ZodDefault<z.ZodBoolean>;
              },
              "strip",
              z.ZodTypeAny,
              {
                enabled: boolean;
              },
              {
                enabled?: boolean | undefined;
              }
            >
          >;
        },
        "strip",
        z.ZodTypeAny,
        {
          github: {
            enabled: boolean;
          };
          jira: {
            enabled: boolean;
          };
        },
        {
          github?:
            | {
                enabled?: boolean | undefined;
              }
            | undefined;
          jira?:
            | {
                enabled?: boolean | undefined;
              }
            | undefined;
        }
      >
    >;
    runtimes: z.ZodDefault<
      z.ZodArray<
        z.ZodObject<
          {
            id: z.ZodString;
            displayName: z.ZodString;
            command: z.ZodString;
            args: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
          },
          "strip",
          z.ZodTypeAny,
          {
            id: string;
            displayName: string;
            command: string;
            args: string[];
          },
          {
            id: string;
            displayName: string;
            command: string;
            args?: string[] | undefined;
          }
        >,
        "many"
      >
    >;
    commandPolicy: z.ZodDefault<
      z.ZodObject<
        {
          hookTimeoutMs: z.ZodDefault<z.ZodNumber>;
          allowDestructiveWorkspaceCleanup: z.ZodDefault<z.ZodBoolean>;
        },
        "strip",
        z.ZodTypeAny,
        {
          hookTimeoutMs: number;
          allowDestructiveWorkspaceCleanup: boolean;
        },
        {
          hookTimeoutMs?: number | undefined;
          allowDestructiveWorkspaceCleanup?: boolean | undefined;
        }
      >
    >;
  },
  "strip",
  z.ZodTypeAny,
  {
    version: 1;
    dataDir: string;
    databasePath: string;
    bindHost: string;
    port: number;
    mcp: {
      enabled: boolean;
    };
    providers: {
      github: {
        enabled: boolean;
      };
      jira: {
        enabled: boolean;
      };
    };
    runtimes: {
      id: string;
      displayName: string;
      command: string;
      args: string[];
    }[];
    commandPolicy: {
      hookTimeoutMs: number;
      allowDestructiveWorkspaceCleanup: boolean;
    };
  },
  {
    dataDir: string;
    databasePath: string;
    version?: 1 | undefined;
    bindHost?: string | undefined;
    port?: number | undefined;
    mcp?:
      | {
          enabled?: boolean | undefined;
        }
      | undefined;
    providers?:
      | {
          github?:
            | {
                enabled?: boolean | undefined;
              }
            | undefined;
          jira?:
            | {
                enabled?: boolean | undefined;
              }
            | undefined;
        }
      | undefined;
    runtimes?:
      | {
          id: string;
          displayName: string;
          command: string;
          args?: string[] | undefined;
        }[]
      | undefined;
    commandPolicy?:
      | {
          hookTimeoutMs?: number | undefined;
          allowDestructiveWorkspaceCleanup?: boolean | undefined;
        }
      | undefined;
  }
>;
export type CitadelConfig = z.infer<typeof CitadelConfigSchema>;
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
export declare function defaultDataDir(): string;
export declare function defaultConfigPath(): string;
export declare function loadConfig(configPath?: string): CitadelConfig;
//# sourceMappingURL=index.d.ts.map
