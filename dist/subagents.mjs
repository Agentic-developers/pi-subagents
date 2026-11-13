// src/spawn-child.ts
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
var THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
];
function defaultAgentsDir(extensionFileUrl = import.meta.url) {
  return join(dirname(fileURLToPath(extensionFileUrl)), "..", "agents");
}
var AGENTS_DIR = process.env.ADW_PI_AGENTS_DIR ?? defaultAgentsDir();
function parseAgentFrontmatter(agentMd) {
  const fmMatch = agentMd.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;
  const frontmatter = fmMatch[1];
  const body = fmMatch[2];
  const modelMatch = frontmatter.match(/^model:\s*(.+)$/m);
  return { model: modelMatch ? modelMatch[1].trim() : void 0, body };
}
function resolveModel(opts) {
  return opts.override ?? opts.frontmatter ?? opts.envDefault ?? "gpt-6-luna";
}
function parseAgentModelPins(raw) {
  const pins = /* @__PURE__ */ new Map();
  for (const entry of (raw ?? "").split(",")) {
    const eq = entry.indexOf("=");
    if (eq < 0) continue;
    const name = entry.slice(0, eq).trim();
    const model = entry.slice(eq + 1).trim();
    if (name && model) pins.set(name, model);
  }
  return pins;
}
function splitThinking(model) {
  const idx = model.lastIndexOf(":");
  if (idx > 0) {
    const suffix = model.slice(idx + 1);
    if (THINKING_LEVELS.includes(suffix)) {
      return { id: model.slice(0, idx), thinking: suffix };
    }
  }
  return { id: model, thinking: null };
}
function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}
function failure(agent, depth, text) {
  return {
    content: [{ type: "text", text }],
    details: { usage: null, depth, agent, model: null, thinking: null, calls: [] },
    isError: true
  };
}
function resolveProvider(env = process.env) {
  return env.ADW_PI_PROVIDER ?? "openai";
}
function buildPiArgs(opts) {
  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--provider",
    opts.provider,
    "--model",
    opts.model
  ];
  if (opts.thinking) {
    args.push("--thinking", opts.thinking);
  }
  args.push("--append-system-prompt", opts.promptFile);
  args.push(`Task: ${opts.task}`);
  return args;
}
async function spawnChildPi(opts) {
  const { agent, task, depth, signal, parentCwd, modelOverride, thinkingOverride } = opts;
  const agentPath = join(AGENTS_DIR, `${agent}.md`);
  let agentMd;
  try {
    agentMd = await readFile(agentPath, "utf-8");
  } catch (_err) {
    return failure(agent, depth, `ERROR: subagent definition not found at ${agentPath}`);
  }
  const parsed = parseAgentFrontmatter(agentMd);
  if (!parsed) {
    return failure(agent, depth, `ERROR: subagent ${agent} has no frontmatter`);
  }
  const { model: frontmatterModel, body } = parsed;
  const pinned = parseAgentModelPins(process.env.ADW_PI_SUBAGENT_MODELS).get(agent);
  const model = resolveModel({
    override: pinned ?? modelOverride,
    frontmatter: frontmatterModel,
    envDefault: process.env.ADW_PI_DEFAULT_SUBAGENT_MODEL
  });
  const thinking = pinned ? void 0 : thinkingOverride;
  const tmpDir = await mkdtemp(join(tmpdir(), "adw-pi-sub-"));
  const promptFile = join(tmpDir, "system-prompt.md");
  await writeFile(promptFile, body, "utf-8");
  const piBin = process.env.ADW_PI_BIN ?? "pi";
  const args = buildPiArgs({
    provider: resolveProvider(),
    model,
    thinking,
    promptFile,
    task
  });
  const childEnv = {
    ...process.env,
    ADW_PI_SUBAGENT_DEPTH: String(depth)
  };
  delete childEnv.ADW_PI_OUTPUT_SCHEMA;
  const proc = spawn(piBin, args, {
    cwd: parentCwd,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const onAbort = () => {
    if (!proc.killed) {
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 5e3);
    }
  };
  signal.addEventListener("abort", onAbort);
  const started = Date.now();
  let lastText = "";
  const totalUsage = emptyUsage();
  let responseModel = null;
  let turns = 0;
  const nestedCalls = [];
  let stderr = "";
  proc.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf-8");
  });
  let buf = "";
  let error = null;
  try {
    await new Promise((resolve, reject) => {
      proc.stdout?.on("data", (chunk) => {
        buf += chunk.toString("utf-8");
        while (true) {
          const idx = buf.indexOf("\n");
          if (idx < 0) break;
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const ev = JSON.parse(line);
            if (ev.type === "turn_end") {
              turns += 1;
            } else if (ev.type === "tool_execution_end" && ev.toolName === "subagent") {
              const calls = ev.result?.details?.calls;
              if (Array.isArray(calls)) nestedCalls.push(...calls);
            } else if (ev.type === "message_end" && ev.message?.role === "assistant") {
              if (typeof ev.message.model === "string" && ev.message.model) {
                responseModel = ev.message.model;
              }
              const u = ev.message.usage ?? {};
              totalUsage.input += u.input ?? 0;
              totalUsage.output += u.output ?? 0;
              totalUsage.cacheRead += u.cacheRead ?? 0;
              totalUsage.cacheWrite += u.cacheWrite ?? 0;
              totalUsage.cost += u.cost?.total ?? 0;
              for (const part of ev.message.content ?? []) {
                if (part.type === "text" && part.text) lastText = part.text;
              }
            }
          } catch {
          }
        }
      });
      proc.on("close", (code) => {
        signal.removeEventListener("abort", onAbort);
        if (code !== 0) {
          return reject(
            new Error(`subagent pi exited with code ${code}: ${stderr.slice(0, 500)}`)
          );
        }
        resolve();
      });
      proc.on("error", reject);
    });
  } catch (err) {
    error = err;
  }
  const requested = splitThinking(model);
  const effectiveThinking = thinking ?? requested.thinking;
  const self = {
    agent,
    model: responseModel ?? requested.id,
    thinking: effectiveThinking,
    depth,
    usage: totalUsage,
    turns,
    durationMs: Date.now() - started,
    isError: error !== null
  };
  const details = {
    usage: totalUsage,
    depth,
    agent,
    model: self.model,
    thinking: effectiveThinking,
    calls: [self, ...nestedCalls]
  };
  if (error !== null) {
    return {
      content: [{ type: "text", text: `ERROR: subagent failed: ${error.message}` }],
      details,
      isError: true
    };
  }
  return {
    content: [{ type: "text", text: lastText || "(subagent returned no text)" }],
    details
  };
}

// src/subagent-tool.ts
function registerSubagentTool(pi) {
  pi.registerTool({
    name: "subagent",
    label: "Delegate to a subagent",
    description: "Spawn an isolated subagent with its own context window. Keep the task narrow. Optionally override the subagent's model and reasoning effort per call.",
    parameters: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          description: "Subagent name (must exist in the agents directory as <name>.md)"
        },
        task: { type: "string", description: "The task description." },
        model: {
          type: "string",
          description: "Override the model for this call (e.g. 'gpt-6.1-sol' or 'gpt-6.1-sol:high'). Omit to use the agent file's model pin."
        },
        thinking: {
          type: "string",
          enum: [...THINKING_LEVELS],
          description: "Override the reasoning effort for this call. Omit to use the model's built-in level."
        }
      },
      required: ["agent", "task"]
    },
    async execute(_id, params, signal) {
      const depth = parseInt(process.env.ADW_PI_SUBAGENT_DEPTH ?? "0", 10);
      if (depth >= 2) {
        return {
          content: [
            {
              type: "text",
              text: "ERROR: subagent recursion depth limit (2) reached. Do the work yourself."
            }
          ],
          isError: true
        };
      }
      return await spawnChildPi({
        agent: params.agent,
        task: params.task,
        depth: depth + 1,
        signal,
        parentCwd: process.cwd(),
        modelOverride: params.model,
        thinkingOverride: params.thinking
      });
    }
  });
}

// src/subagents.ts
function registerExtension(pi) {
  registerSubagentTool(pi);
}
export {
  registerExtension as default
};
