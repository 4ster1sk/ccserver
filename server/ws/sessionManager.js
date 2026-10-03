import * as pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, rmSync, statSync } from 'node:fs';
import { readJsonFileIfRegular } from './regularFile.js';
// `dirname` / `fileURLToPath` were only here to build __dirname for the
// repo-root state-file paths; #201 moved those to the registry (see
// schedulesPath below), so they are gone. master's
// opencodeSupportsStandalone (#200) is kept -- it is used by the
// opencodeStandalone flag further down.
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { qemuVmPool } from './qemuVmPool.js';
import { LAUNCHER_SCRIPT as QEMU_LAUNCHER } from './sandbox-qemu.js';
import { buildSandboxSpawn, resolveApp, sandboxAvailable, sandboxUnavailableReason, forceSandboxUnavailableReason, loadSandboxConfig, resolveSandboxBackend, persistentHomeDir, dockerSandboxAvailable, dockerdStatus, dockerdLockHeld, resolveTools, opencodeSupportsStandalone, chatBridgeArgv, CHAT_PASSWORD_NAME } from './sandbox.js';
import { prepareChatDir, removeChatDir, createChatState, publicChatState, feedChatOutput, failChat, initChatSession, sendChatPrompt, startChatMonitor, stopChatMonitor } from './opencodeChat.js';
import * as gpgVaultRelay from './gpgVaultRelay.js';
import { brokerArmed, setSessionBrokerLists, setSessionBrokerOpMode } from './netbrokerClient.js';
import { buildMcpConfigArgsAndEnv } from './mcpConfig.js';
import { shouldInjectNotify, notifyEnabled, getNotifySockPath, notifyBrokerRunning } from './notify.js';
import { buildAgentNotifyArgsAndEnv, shouldCaptureNotifications } from './agentNotifyConfig.js';
import { attachNotifyDetector, handleAgentNotification } from './notifyBridge.js';
import { shouldInjectUsage, usageEnabled, getUsageSockPath, usageBrokerRunning } from './usageMcp.js';
import { createScreenModel, SCREEN_ROWS } from './screenModel.js';
import {
  MAX_ROWS_PER_SAMPLE,
  MAX_SAMPLES,
  NO_ACTIVITY,
  RATE_HOLD_WINDOW_MS,
  RATE_WINDOW_MS,
  SAMPLE_MS,
  changeRateFromSamples,
  classifyActivity,
  normalizeRowsForWidth,
} from './activity.js';
import { bunTmpdirEnv } from './bunTmpdir.js';
import { buildSessionEnv } from './sessionEnv.js';
import { isContained } from '../pathPolicy.js';
import {
  isValidApp,
  appLaunchArgs,
  appChatArgs,
  appSupportsChat,
  normalizeSessionUi,
  appSubmitKey,
  extractResumeSessionId,
  detectPermissionPrompt,
} from './appLaunch.js';
import { stripAnsi } from './stripAnsi.js';
import { findSessionLimitReset } from './sessionLimitDetect.js';
import { recordSessionLimitReset } from '../sessionLimitState.js';
import { getChatDefaultModel, setChatDefaultModel } from '../chatDefaults.js';
import {
  parseTimeoutEnv,
  DEFAULT_SESSION_TIMEOUT_MS,
  DEFAULT_SESSION_EXITED_TIMEOUT_MS,
  MIN_SESSION_EXITED_TIMEOUT_MS,
} from '../timeoutEnv.js';
import { resolvePath, PATH_IDS } from '../paths.js';

// Functions, not module-load constants (issue #201): the registry resolves
// these against $XDG_STATE_HOME and has to be free to answer differently
// after the setup wizard moves a file, so nothing may freeze a path at
// import time. CCSERVER_SCHEDULES_PATH still overrides.
export function schedulesPath() { return resolvePath(PATH_IDS.scheduledPrompts); }

const OUTPUT_BUFFER_MAX_BYTES = 512 * 1024;
const IDLE_TIMEOUT_MS = 3000;

// Both timeouts are operator-tunable. Parsed once at module load (env changes
// mid-process are not a supported scenario) but exported as functions so the
// parsing rules themselves stay directly testable.

// Idle (no viewer attached) destroy timeout. 0 or negative disables it
// entirely -- the session then lives until the pty exits or someone tears it
// down explicitly.
export function resolveSessionTimeoutMs(env = process.env) {
  return parseTimeoutEnv(env.CCSERVER_SESSION_TIMEOUT_MS, {
    name: 'CCSERVER_SESSION_TIMEOUT_MS',
    fallback: DEFAULT_SESSION_TIMEOUT_MS,
    min: 0,
  });
}

// Cleanup delay after the pty has exited. Never disabled: an exited session
// has no process left, and keeping it forever would fill the session list
// with rows that can never be attached to again.
export function resolveExitedTimeoutMs(env = process.env) {
  return parseTimeoutEnv(env.CCSERVER_SESSION_EXITED_TIMEOUT_MS, {
    name: 'CCSERVER_SESSION_EXITED_TIMEOUT_MS',
    fallback: DEFAULT_SESSION_EXITED_TIMEOUT_MS,
    min: MIN_SESSION_EXITED_TIMEOUT_MS,
  });
}

const SESSION_TIMEOUT_MS = resolveSessionTimeoutMs();
const SESSION_EXITED_TIMEOUT_MS = resolveExitedTimeoutMs();

const sessions = new Map();

// Persistent sandbox HOME paths currently being prepared by createSession().
// buildSandboxSpawn became async when the network broker startup handshake was
// moved to a pipe, so a launch is now observable between the existing
// live-session conflict check and sessions.set(). Track that interval here:
// destructive fresh launches must not race another launch, and the settings
// deletion guard must treat a HOME being mounted/prepared as in use too.
export class SandboxHomeLaunchReservations {
  constructor() {
    this.counts = new Map();
  }

  reserve(homePath, { fresh = false, liveSessions = [] } = {}) {
    if (fresh && (
      sandboxHomeConflict(homePath, liveSessions)
      || (this.counts.get(homePath) || 0) > 0
    )) return false;
    this.counts.set(homePath, (this.counts.get(homePath) || 0) + 1);
    return true;
  }

  release(homePath) {
    if (!homePath) return;
    const next = (this.counts.get(homePath) || 0) - 1;
    if (next > 0) this.counts.set(homePath, next);
    else this.counts.delete(homePath);
  }

  count(homePath) {
    return this.counts.get(homePath) || 0;
  }
}

const sandboxHomeLaunchReservations = new SandboxHomeLaunchReservations();

// Set when gracefulShutdown() starts and never cleared: the process is on its
// way out.
function resolveCommand(cmd) {
  if (process.platform !== 'win32') return cmd;
  try {
    return execFileSync('where.exe', [cmd], { encoding: 'utf-8' }).split('\r\n')[0].trim();
  } catch {
    return cmd;
  }
}

function extractResumeId(session) {
  return extractResumeSessionId(session.app, session.outputBuffer.slice(-50).join(''));
}

// Prefixes marking a createSession() failure as a server-side infrastructure
// fault rather than a rejection of the request as given. Exported so HTTP
// route layers classify without re-typing the strings.
// "...sets \"browseRoots\"" covers the mustSandboxShell/mustSandboxAgent
// refusal above (sandbox mandatory but unbuildable) -- an infra fault like
// forceSandbox's, not a request-shape rejection like the separate
// cwd-outside-browseRoots refusal (which intentionally does NOT start with
// any of these prefixes, since it IS a rejection of the request as given).
export const INFRA_ERROR_PREFIXES = ['Failed to build sandbox', 'Failed to spawn', 'Cannot launch: sandbox.config.json sets "forceSandbox"', 'Cannot launch: sandbox.config.json sets "browseRoots"'];

/**
 * Whether a createSession() error message reports infrastructure failure
 * (sandbox build / process spawn) as opposed to a bad request.
 * @param {string} msg Error message from createSession().
 * @returns {boolean}
 */
export function isInfrastructureError(msg) {
  return INFRA_ERROR_PREFIXES.some((p) => String(msg || '').startsWith(p));
}

// Model normalization for storage/serialization: `model` is an optional
// non-empty string, or explicit null meaning "use the app default model". Any
// other value (empty string, wrong type) is coerced to null so an invalid
// value can never leak into persistence or the CLI arg builder.
function normalizeModel(model) {
  return typeof model === 'string' && model.length > 0 ? model : null;
}

// The first idle gap of a freshly-launched TUI (or a chat session becoming
// ready): mark the session settled and wake anyone waiting on the settle
// gate (send_input's waitUntilSettled).
function markSettled(session) {
  if (!session.settled) {
    session.settled = true;
    const waiters = session.settleWaiters;
    session.settleWaiters = [];
    for (const w of waiters) w();
  }
}

// A scheduled prompt may be waiting for this (freshly auto-resumed) session
// to settle before typing its text. Deliver it once quiet / ready.
function deliverPendingInjection(session) {
  if (!session.pendingInjection) return;
  const inj = session.pendingInjection;
  session.pendingInjection = null;
  if (session.pendingInjectionTimer) {
    clearTimeout(session.pendingInjectionTimer);
    session.pendingInjectionTimer = null;
  }
  const delivered = injectIntoLiveSession(session, inj.text);
  notifyFired(session, { at: inj.at, text: inj.text }, delivered);
}

// Builds the `session` record and wires its ptyProcess onData/onExit
// listeners. The only caller is createSession(); factored out to keep that
// function's spawn logic separate from the record/listener wiring.
function buildSessionRecord(id, ptyProcess, meta) {
  const session = {
    id,
    cwd: meta.cwd,
    shell: !!meta.shell,
    app: meta.app,
    model: meta.model,
    permissionMode: meta.permissionMode,
    // 'terminal' (TUI in the pty) or 'chat' (opencode serve behind the chat
    // proxy, see opencodeChat.js). `chat` holds the latter's state.
    ui: meta.ui || 'terminal',
    chat: meta.chat || null,
    // Operator-assigned display name (null = none; the UI falls back to the
    // directory basename). Set post-launch via setSessionLabel (PATCH
    // /api/sessions/:id), never from launch input -- launch bodies are
    // forwarded nearly as-is across trust boundaries (REST and MCP),
    // so a display string must not ride along with them.
    customLabel: normalizeCustomLabel(meta.customLabel),
    sandbox: !!meta.sandbox,
    sandboxOpts: meta.sandbox ? (meta.sandboxOpts || null) : null, // per-launch gpg/sshAgent override, for schedule/resume replay
    docker: !!meta.docker, // whether THIS session's sandbox launched with docker (see dockerAvailability)
    gpgVaultActive: !!meta.gpgVaultActive, // effective gpgVault flag at launch (server/ws/sandbox.js's resolved `gpgVault`, not just the raw sandboxOpts override) -- see terminal.js's `session` WS message / listSessions()
    dockerTag: meta.docker && meta.sandboxStateDir ? basename(meta.sandboxStateDir) : null, // matches CCSANDBOX_DOCKERD_TAG (sandbox.js), identifies this session's dockerd in the status file
    sandboxStateDir: meta.sandboxStateDir ?? null, // rootlesskit state dir to remove on teardown (docker only)
    sandboxGitBrokerProc: meta.sandboxGitBrokerProc ?? null, // host-side git-broker child process, killed on teardown
    sandboxGitBrokerDir: meta.sandboxGitBrokerDir ?? null, // its runtime dir (socket + allow-list), removed on teardown
    sandboxCommitGuardDir: meta.sandboxCommitGuardDir ?? null, // commit-msg guard's runtime dir (config json only, no process), removed on teardown
    qemuRunDir: meta.qemuRunDir ?? null, // qemu backend: per-session VM run dir (overlay, seed, keys), removed on teardown
    qemuPoolLease: meta.qemuPoolLease ?? null, // qemu backend, persistent VM: this session's attachment (qemuVmPool.js), released on teardown
    sandboxBackend: meta.sandboxBackend ?? null, // 'bwrap' | 'qemu' when sandboxed (picked per launch or the default), else null
    qemuVm: meta.qemuVm ?? null, // qemu backend: { templateId, templateName, memoryMiB, cpus, diskGiB, startedAt } for the Settings VM list
    // Network-isolation broker (qemu backend, Go broker): adminSock/armed/mode
    // are plain data, needed for the running-session toggle's and
    // pushNetworkPolicyToArmedSessions's live calls straight from this
    // process. sandboxNetworkBrokerProc/Dir (the process handle/runtime dir
    // to kill/remove on teardown) mirror sandboxGitBrokerProc/Dir.
    networkBrokerAdminSock: meta.networkBrokerAdminSock ?? null, // Go broker admin socket
    networkIsolateArmed: !!meta.networkIsolateArmed,
    networkIsolateMode: meta.networkIsolateMode ?? null, // 'enforce' | 'open', mutated live by the running-session toggle
    networkExtraAllowedHosts: meta.networkExtraAllowedHosts ?? [], // hosts the launch allowed on top of the allow-list (VM agent API hosts, qemuAgents.js), kept across live list pushes
    sandboxNetworkBrokerProc: meta.sandboxNetworkBrokerProc ?? null,
    sandboxNetworkBrokerDir: meta.sandboxNetworkBrokerDir ?? null,
    reuseSandboxHome: meta.reuseSandboxHome, // true = keep the previous persistent HOME, false = started fresh (wiped)
    ptyProcess,
    // The single attached client (at most one: attaching a second client
    // evicts the incumbent -- see attachSocket). Null while nobody is
    // watching; the destroy timer runs only in that state.
    socket: null,
    outputBuffer: [],
    bufferSize: 0,
    cols: meta.cols,
    rows: meta.rows,
    createdAt: Date.now(), // for the uptime figure in the teardown log
    exited: false,
    exitCode: null,
    exitSignal: null,
    timeoutTimer: null,
    claudeSessionId: null,
    idleTimer: null,
    settled: false, // reached the first idle gap (TUI init burst over) -- the send_input settle gate
    settleWaiters: [], // resolvers waiting on `settled` (see waitUntilSettled)
    lastOutputAt: null, // epoch ms of the most recent output chunk; null until the first one (activity timestamp, Issue #16)
    autoYes: false,
    autoYesLog: [],
    autoYesPending: null,
    autoYesBuf: '',
    // Session-limit auto-resume detection (see sessionLimitDetect.js).
    // limitDetectBuf holds a sliding window of RAW bytes, not yet
    // ANSI-stripped: a pty chunk boundary can split an escape sequence
    // mid-sequence, and stripping each chunk independently would leak the
    // tail of a split sequence as bare control bytes. Accumulating raw
    // bytes and stripping the whole window each time lets the next chunk's
    // arrival complete a sequence the previous chunk left dangling.
    // lastAutoLimitResetAt is the resetAtMs already scheduled for, so a TUI
    // redraw of the same status line doesn't re-arm the schedule every chunk.
    limitDetectBuf: '',
    lastAutoLimitResetAt: null,
    startedClaudeSessionId: meta.startedClaudeSessionId ?? null,
    scheduleId: null, // key into the module-level `schedules` map, if any
    pendingInjection: null, // { text, at } — scheduled prompt awaiting a freshly-resumed session
    pendingInjectionTimer: null, // RESUME_INJECT_FALLBACK_MS safety net; cleared on teardown
    // Lightweight virtual screen (see screenModel.js): fed every output
    // chunk, exposing the current visible screen and a change counter so
    // read_output can tell "spinner still drawing" from "static screen".
    // screenLastChangeAt is stamped when the screen visibly changes (not on
    // every byte) -- the basis of read_output's screenIdleMs / get_tab_status.
    screen: createScreenModel({ cols: meta.cols, rows: SCREEN_ROWS }),
    screenLastChangeAt: null,
    // Activity sampling (see activity.js): a small ring of
    // { at, rows } slices -- how many DISTINCT screen rows changed in each
    // ~SAMPLE_MS window. That is what separates "thinking" (a spinner
    // rewriting one row) from "working" (output painting many), which
    // screenLastChangeAt alone cannot. Bounded at MAX_SAMPLES entries.
    screenSamples: [],
    screenSampleAt: null, // when the current slice started
    activityLevel: null, // last level reported, so activitySnapshot's red/yellow hysteresis has a history
  };

  ptyProcess.onData((rawData) => {
    const data = rawData;
    // Activity timestamp: every output chunk counts, shells included (unlike
    // the agent-only idle detection below). Pure activity bookkeeping.
    session.lastOutputAt = Date.now();
    appendToBuffer(session, data);

    // Chat mode: the pty carries only the bridge's / launcher's log and its
    // startup-stage markers (see chatStages.js) -- none of the TUI
    // detectors below apply.
    if (session.chat) {
      const { changed, agentUp } = feedChatOutput(session.chat, data);
      if (changed) broadcastChatState(session);
      if (agentUp) {
        initChatSession(session.chat, {
          onChange: () => {
            // Ready is a chat session's "settled" (send_input's gate, a
            // scheduled prompt waiting on a fresh resume).
            if (session.chat.ready) {
              markSettled(session);
              deliverPendingInjection(session);
              startChatMonitor(session.chat, {
                isAlive: () => !session.exited && sessions.get(session.id) === session,
                // The agent notification bridge (notifyBridge.js), for the
                // events a TUI would have announced with OSC 9/777. Armed
                // at launch exactly like the pty detector (chatNotify).
                onNotify: session.chatNotify
                  ? ({ title, body }) => {
                    handleAgentNotification(session, { kind: 'notification', source: 'chat', title, body }).catch(() => {});
                  }
                  : null,
                // The last model / effort picked becomes what the app's next
                // chat session starts with (chatDefaults.js).
                onModelSelected: (model) => setChatDefaultModel(session.app, model),
              });
            }
            broadcastChatState(session);
          },
        }).catch((err) => console.warn(`[chat] ${session.id}: ${err.message}`));
      }
      broadcast(session, { type: 'output', data });
      return;
    }

    // Session-limit auto-resume detection -- role/app agnostic, applies to
    // every session per the plan (a shell session simply never matches).
    // See sessionLimitDetect.js for the regex/timezone-math and the
    // limitDetectBuf field above for why raw bytes are accumulated instead
    // of stripping each chunk independently.
    session.limitDetectBuf = (session.limitDetectBuf + data).slice(-LIMIT_DETECT_BUF_MAX_CHARS);
    const limitMatch = findSessionLimitReset(stripAnsi(session.limitDetectBuf));
    if (limitMatch && limitMatch.resetAtMs !== session.lastAutoLimitResetAt) {
      // Identify this limit event by its resetAtMs so the TUI redrawing the
      // same status line (which keeps re-matching every chunk) doesn't
      // re-arm the schedule on every redraw.
      session.lastAutoLimitResetAt = limitMatch.resetAtMs;
      // Independent of the auto-schedule lifecycle below (which can be
      // skipped when a manual schedule already exists) -- the scheduler
      // panel's default-time hint should still learn about this detection.
      recordSessionLimitReset({
        resetAtMs: limitMatch.resetAtMs,
        timeZone: limitMatch.timeZone,
        source: 'session-output',
      });
      const existingSid = scheduleForSession(session.id);
      const existing = existingSid ? schedules.get(existingSid) : null;
      // A manual schedule (set via the browser's clock panel) is never
      // clobbered by the auto-detector, even if it looks stale relative to
      // the new reset time -- the user's explicit intent wins. An existing
      // 'auto-session-limit' schedule is safe to replace with this fresher
      // detection (normally unreachable here, since the resetAtMs guard
      // above already filters out same-event redraws).
      if (!existing || existing.source === 'auto-session-limit') {
        const scheduled = setScheduledPrompt(
          session.id,
          limitMatch.resetAtMs + SESSION_LIMIT_RESUME_DELAY_MS,
          SESSION_LIMIT_RESUME_MESSAGE,
          { source: 'auto-session-limit' },
        );
        if (scheduled) {
          notifyScheduleState(session);
        } else {
          console.warn(`[session-limit] could not auto-schedule a resume for session ${session.id} (reset ${new Date(limitMatch.resetAtMs).toISOString()})`);
        }
      } else {
        console.warn(`[session-limit] session ${session.id} hit its limit, but a manual schedule already exists -- not overriding it`);
      }
    }

    // Agent notification capture (plan-notify-bridge). Only sessions the
    // bridge was armed for at launch carry a detector, so this is a property
    // check for everyone else. The detector never throws and never blocks:
    // delivery is dispatched off a resolved promise (see notifyBridge.js).
    if (session.notifyDetector) session.notifyDetector.feed(data);

    // Keep the virtual screen model in parallel with the buffer: it only
    // stamps screenLastChangeAt when the visible screen actually changes,
    // so a spinner redrawing the same line registers as activity while a
    // byte flow that leaves the screen static does not.
    const screenVersion = session.screen.version();
    session.screen.feed(data);
    if (session.screen.version() !== screenVersion) {
      session.screenLastChangeAt = Date.now();
    }
    // Bank a slice of the dirty-row tally whenever one is due. Sampling here
    // (rather than on an interval) keeps the cost proportional to output:
    // a session nobody is writing to does no work at all. activitySnapshot
    // closes the remaining slice when it reads, so output that stops mid-slice
    // is still counted.
    sampleScreenActivity(session);

    broadcast(session, { type: 'output', data });

    // Idle detection: reset timer on every output chunk (Claude sessions only)
    if (!session.shell) {
      if (session.idleTimer) {
        clearTimeout(session.idleTimer);
      }
      session.idleTimer = setTimeout(() => {
        if (session.exited) return;
        // The first idle gap means a freshly-launched TUI has finished its
        // initialization burst: mark the session settled and wake anyone
        // waiting on the settle gate (send_input's waitUntilSettled).
        markSettled(session);
        // A scheduled prompt may be waiting for this (freshly auto-resumed)
        // session to settle before typing its text. Deliver it once quiet.
        deliverPendingInjection(session);
      }, IDLE_TIMEOUT_MS);

      // Auto-yes detection for agent permission prompts. Claude uses Ink's
      // Select UI, opencode renders a "Permission required" box, and Codex
      // uses a numbered approval menu. Each selects its one-time approval by
      // default, so Enter is the shared response.
      if (session.autoYes) {
        // Strip all ANSI escape sequences
        const ansiRe = /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[()][A-Z0-9]|[>=<]|#[0-9])/g;
        const stripped = data.replace(ansiRe, '');
        // Accumulate stripped text since last auto-yes response (max 10KB)
        session.autoYesBuf += stripped;
        if (session.autoYesBuf.length > 10000) {
          session.autoYesBuf = session.autoYesBuf.slice(-5000);
        }
        const buf = session.autoYesBuf;
        // Ink renders text with cursor positioning, so spaces may be missing after ANSI strip
        const bufNoSpace = buf.replace(/\s+/g, '');
        const hasPermissionPrompt = detectPermissionPrompt(session.app, bufNoSpace);
        if (hasPermissionPrompt) {
          if (session.autoYesPending) clearTimeout(session.autoYesPending);
          session.autoYesPending = setTimeout(() => {
            session.autoYesPending = null;
            if (session.exited || !session.autoYes) return;
            // Clean up prompt text for display: re-insert spaces around known words
            const cleanBuf = buf
              .replace(/[^\x20-\x7E\n]/g, ' ')  // remove non-printable chars
              .replace(/\s+/g, ' ').trim();
            // Extract a meaningful description from the buffer
            const noSpace = cleanBuf.replace(/\s/g, '');
            let promptLine = 'permission prompt';
            if (session.app === 'opencode' || session.app === 'codex') {
              // Neither TUI's byte stream exposes which tool is being approved,
              // so the label stays generic (claude's does carry tool names).
              promptLine = 'Permission prompt (auto-approved)';
            } else {
              const editMatch = noSpace.match(/makethiseditto\s*(\S+)/i);
              const fetchMatch = noSpace.match(/Claudewantstofetchcontentfrom\s*(\S+)/i);
              const searchMatch = noSpace.match(/Claudewantstosearchthewebfor:\s*(.+?)(?:\}|$)/i);
              if (editMatch) {
                promptLine = `Edit: ${editMatch[1]}`;
              } else if (fetchMatch) {
                promptLine = `Fetch: ${fetchMatch[1]}`;
              } else if (searchMatch) {
                promptLine = `Web Search: ${searchMatch[1]}`;
              } else if (/Doyouwanttoproceed/i.test(noSpace)) {
                // Try to find tool name from nearby text like "Bash(...)" or "Read(...)"
                const toolMatch = noSpace.match(/(Bash|Read|Write|Edit|Glob|Grep|WebFetch|WebSearch|NotebookEdit)\(/i);
                promptLine = toolMatch ? `${toolMatch[1]} (auto-approved)` : 'Tool use (auto-approved)';
              } else {
                promptLine = cleanBuf.slice(0, 80) || 'permission prompt';
              }
            }
            const entry = { time: Date.now(), prompt: promptLine };
            session.autoYesLog.push(entry);
            if (session.autoYesLog.length > 100) session.autoYesLog.shift();
            // Reset buffer after responding — prevents re-matching old prompts
            session.autoYesBuf = '';
            // Send Enter key — default-focused option is "Yes"
            session.ptyProcess.write('\r');
            broadcast(session, { type: 'auto_yes', entry });
          }, 500);
        }
      }
    }
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    session.exited = true;
    session.exitCode = exitCode;
    session.exitSignal = signal;
    if (session.chat) stopChatMonitor(session.chat);
    if (session.chat && failChat(session.chat, `プロセスが終了しました (${signal ? `signal ${signal}` : `code ${exitCode}`})`)) {
      broadcastChatState(session);
    }
    if (session.chat && session.app === 'claude') {
      // The bridge's conversation is Claude Code's session id itself.
      session.claudeSessionId = session.chat.ocSessionId || null;
    } else if (!session.shell) {
      session.claudeSessionId = extractResumeSessionId(
        session.app,
        session.outputBuffer.slice(-50).join('')
      );
    }

    // Keep any pending scheduled prompt alive across this exit: refresh its
    // resume id and detach it so it auto-resumes the conversation at fire time.
    refreshScheduleOnExit(session);

    // A persistent VM's shares are only this session's while it runs; let
    // the pool unmount them (and idle the VM) now rather than at destroy.
    if (session.qemuPoolLease) session.qemuPoolLease.release().catch(() => {});

    // Until this landed nothing recorded WHY a session went away, so a pty
    // that died while the tab was closed was indistinguishable from a
    // server restart -- both just surfaced as SESSION_NOT_FOUND on the next
    // open. Log the exit itself, and see destroySession for the teardown.
    console.log(
      `[session] ${session.id} pty exited (code=${exitCode}, signal=${signal ?? 'none'}, `
      + `app=${session.app || (session.shell ? 'shell' : 'unknown')}, cwd=${session.cwd}, `
      + `connected=${!!session.socket}, uptime=${Date.now() - session.createdAt}ms)`
    );

    broadcast(session, {
      type: 'exit',
      exitCode,
      signal,
      claudeSessionId: session.claudeSessionId,
    });

    if (!session.socket && sessions.has(session.id)) {
      startTimeout(session, SESSION_EXITED_TIMEOUT_MS);
    }
  });

  sessions.set(id, session);



  return session;
}

export async function createSession({ cwd, cols, rows, claudeSessionId, shell, sandbox, sandboxOpts, app, model, resumeLast, reuseSandboxHome = true, sandboxHomeCreatedBy = null, customLabel = null, ui = 'terminal' }) {
  const id = randomUUID();
  // Read once and thread through: this hot path (every session launch) was
  // otherwise re-reading + re-parsing sandbox.config.json up to four times
  // (defaultApp, hiddenApps, forceSandbox, persistentHome) via separate
  // loadSandboxConfig() calls below.
  const cfg = loadSandboxConfig();
  // bwrap or the qemu VM: picked per launch (sandboxOpts.backend), else the
  // configured default. Every availability check and refusal below is about
  // THIS backend, never a fallback to the other one.
  const backend = resolveSandboxBackend(sandboxOpts);

  // claude (and likely opencode) aborts immediately (SIGABRT, exit 134, no
  // output at all) when launched with the filesystem root as cwd -- refuse
  // with a clear error instead of the opaque crash. Reachable via the
  // directory browser's own "/" fallback (used until the home-dir fetch
  // resolves, or if the user navigates all the way up and launches there),
  // not just automated/edge-case callers. Plain unsandboxed shells are
  // unaffected: plain /bin/bash starts fine at /.
  //
  // A SANDBOXED shell at / is refused too: the project subtree rule would
  // become a "/" bind, silently granting the whole filesystem -- a fail-open
  // sandbox. Shell
  // sessions only run sandboxed under forceSandbox or an explicit per-launch
  // sandbox request, so the refusal is gated on those. The "would grant the
  // whole filesystem" wording only fits when a sandbox would actually be
  // built: `sandbox:true` on a host with no available backend (forceSandbox
  // off) constructs no sandbox, so the raw-flag check still refuses the launch
  // (a `/` cwd is invalid regardless of backend) but drops the counterfactual
  // clause from the message.
  if (cwd === '/' && (!shell || sandbox || cfg.forceSandbox)) {
    const wouldSandbox = process.platform !== 'win32' && sandboxAvailable(backend);
    return {
      sessionId: id,
      session: null,
      error: !shell
        ? 'Cannot launch in the filesystem root (/) -- claude aborts immediately there. Choose a working directory first.'
        : wouldSandbox
          ? 'Cannot launch a sandboxed shell in the filesystem root (/) -- the sandbox would grant the whole filesystem. Choose a working directory first.'
          : 'Cannot launch a sandboxed shell in the filesystem root (/). Choose a working directory first.',
    };
  }

  // browseRoots (issue #189): when set, every session's cwd must fall
  // inside one of these directories -- agent or shell, sandboxed or not.
  // Checked unconditionally, not just when sandboxRequested below: a launch
  // that is refused for lacking a sandbox backend must still be refused for
  // a cwd outside the roots, and the two failures want different messages.
  const absCwd = resolve('/', cwd);
  // Fail closed on a present-but-unusable browseRoots (or an unparseable
  // config): see loadSandboxConfig's browseRootsInvalid. Silently falling
  // back to host-wide here would turn a config typo into a security
  // downgrade.
  if (cfg.browseRootsInvalid) {
    return {
      sessionId: id,
      session: null,
      error: 'Cannot launch: sandbox.config.json\'s "browseRoots" is invalid (must be an array of directory paths), so the allowed working directories cannot be determined. Fix the config and reload.',
    };
  }
  if (cfg.browseRoots.length > 0 && !isContained(absCwd, cfg.browseRoots)) {
    return {
      sessionId: id,
      session: null,
      error: `Cannot launch: working directory is outside the allowed browseRoots (sandbox.config.json's "browseRoots"). Choose a directory under one of: ${cfg.browseRoots.join(', ')}`,
    };
  }

  // Which agent CLI this session runs. Shell sessions have no app.
  const sessionApp = shell ? null : (isValidApp(app) ? app : cfg.defaultApp);

  // Self-review (issue #105): sandbox.config.json's hiddenApps removes an app
  // from every launch picker client-side, but every picker ultimately funnels
  // its choice through this same createSession(). Without
  // a check here, hiding an app is purely cosmetic -- any client that sends
  // `app` directly (a hand-crafted WS/API call, a stale MCP preset, a worker
  // preset saved before the app was hidden) would still start a real session
  // for an app the operator hasn't contracted for. Refuse the same way the
  // not-installed check below does, rather than trusting every caller to have
  // re-checked hiddenApps itself. Checked BEFORE resolveApp() below: once an
  // app is hidden, whether it happens to be installed is irrelevant, and this
  // ordering means the refusal never depends on install detection.
  if (sessionApp && cfg.hiddenApps.includes(sessionApp)) {
    return {
      sessionId: id,
      session: null,
      error: `Cannot launch: ${sessionApp} is hidden on this server (sandbox.config.json's "hiddenApps"). Remove it from hiddenApps to allow launches.`,
    };
  }
  const resolved = sessionApp ? resolveApp(sessionApp) : null;

  // Refuse launches of an agent that doesn't exist on this host, instead of
  // letting node-pty fail with an opaque execvp/ENOENT error (exit 127) right
  // after the "起動しました" message. resolveApp's `found` covers every search
  // path (PATH, the server's node bin dir, ~/.local/bin, and the app-specific
  // extras) and honors the claudeBin override; the searched-dirs text mirrors
  // resolveAgentCommand's candidates. A defaultApp pointing at a missing
  // install is refused the same way: silently switching to another app would
  // start scheduled prompts / orchestrator restarts in an unintended agent.
  if (sessionApp && !resolved.found) {
    const searched = {
      claude: "PATH, the server's node bin directory, ~/.local/bin",
      opencode: "PATH, the server's node bin directory, ~/.local/bin, ~/.opencode/bin",
      codex: "PATH, the server's node bin directory, ~/.local/bin",
    }[sessionApp];
    return {
      sessionId: id,
      session: null,
      error: `Cannot launch: ${sessionApp} is not installed on this server (searched ${searched}).`,
    };
  }
  // Which model this session launches with. Explicit null / absent means "use
  // the app's persisted-or-default model" (no --model flag is emitted); only a
  // non-empty string becomes a CLI model selection. Shells never carry one.
  const sessionModel = shell ? null : normalizeModel(model);
  const sessionPermissionMode = 'standard';

  // Chat mode (opencode >= 2, Claude Code): refused outright rather than
  // silently started as a terminal, since the browser would render the
  // wrong view.
  const sessionUi = shell ? 'terminal' : normalizeSessionUi(ui);
  if (sessionUi === 'chat' && !appSupportsChat(sessionApp, { opencodeV2: sessionApp === 'opencode' && opencodeSupportsStandalone(resolved.hostCommand) })) {
    return {
      sessionId: id,
      session: null,
      error: sessionApp === 'opencode'
        ? 'Cannot launch: chat mode needs opencode 2.0 or later (the installed opencode is older). Launch it as a terminal instead.'
        : `Cannot launch: chat mode is not available for ${sessionApp}.`,
    };
  }

  // ccserver-notify injection (see notify.js): agent sessions get the
  // process-global notify MCP server when the
  // feature is enabled (Discord webhook configured or subscriptions exist)
  // AND the broker is actually listening (it is started once at boot). The
  // broker-running check prevents injecting a dead socket path when the boot
  // startup failed, or when a config edit enables notify without a restart.
  // Shells never do. The socket path is the process-global
  // one, created once at boot (ensureNotifyBroker).
  const useNotify = notifyBrokerRunning() && shouldInjectNotify({
    shell: !!shell,
    app: sessionApp,
    notifyEnabled: notifyEnabled(),
  });
  const notifySocketPath = useNotify ? getNotifySockPath() : null;

  // Per-connection identity for ccserver-notify (see notify.js / mcpBroker.js):
  // rides to the bridge as CCSERVER_NOTIFY_IDENTITY and becomes the "_from:"
  // footer on this session's notifications. Attribution only -- never an
  // authorization input. createSession refuses the filesystem root for agent
  // sessions, so basename(cwd) is meaningful.
  const notifyIdentity = useNotify ? {
    sessionId: id,
    cwd,
    projectName: basename(cwd),
    app: sessionApp,
  } : null;

  // ccserver-usage injection (see usageMcp.js): every claude session (shells
  // and opencode excluded -- see shouldInjectUsage) gets the
  // process-global get_usage MCP tool when the feature is enabled (claude
  // installed AND usageMcp explicitly enabled) AND the broker is
  // actually listening.
  const useUsage = usageBrokerRunning() && shouldInjectUsage({
    shell: !!shell,
    app: sessionApp,
    usageEnabled: usageEnabled(),
  });
  const usageSocketPath = useUsage ? getUsageSockPath() : null;

  // Server-only variables (NODE_ENV, PORT, CCSERVER_*, forwarded ssh-agent)
  // must not reach the session; see sessionEnv.js.
  const cleanEnv = buildSessionEnv();

  let command, args;
  if (shell) {
    command = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');
    args = [];
  } else {
    command = resolved.command;
    // appLaunchArgs combines resume + model + permission-mode args in this
    // exact order; appLaunch.test.js exercises the same function so a
    // reordering here can't drift away from what's tested (see PR#108 review).
    // opencodeStandalone is probed against the actually-resolved binary
    // (resolved.hostCommand) rather than assumed -- see appLaunch.js's
    // appStandaloneArgs comment: an opencode <2.0.0 install rejects the flag
    // outright, so this must never be passed without checking first.
    args = sessionUi === 'chat' ? appChatArgs(sessionApp, { model: sessionModel }) : appLaunchArgs(sessionApp, {
      resumeId: claudeSessionId,
      resumeLast,
      model: sessionModel,
      opencodeStandalone: sessionApp === 'opencode' && opencodeSupportsStandalone(resolved.hostCommand),
    });
  }
  command = resolveCommand(command);

  // forceSandbox (sandbox.config.json) overrides the client's per-launch
  // choice: every session -- agents and shells alike -- must run sandboxed,
  // and a launch is refused when the sandbox can't be built instead of
  // falling back to a direct spawn. `sandboxRequested` is the mode oracle for
  // the MCP bridge config below: a requested sandbox either builds (mode
  // 'sandbox') or errors out (the config is then never used), so 'host' is
  // only ever reached when the session genuinely runs unsandboxed.
  // One flag, decided in loadSandboxConfig (see its forceSandbox), covering
  // both causes: the operator wrote "forceSandbox": true, or browseRoots is
  // set -- which implies it, because browseRoots confines only where the Web
  // UI may browse and launch, never what a started process can reach. There
  // is deliberately no shell/agent split any more: an agent runs shell
  // commands, so an unsandboxed one walks out of the roots exactly like a
  // shell does (the retired allowUnsandboxedAgents assumed otherwise).
  //
  // Nothing here re-derives that judgement. The Web UI reads the same field
  // off /api/dirs/home, so the menu and the enforcement cannot disagree --
  // they did, and that was issue #251.
  const forceSandbox = cfg.forceSandbox;
  const sandboxMandatory = forceSandbox;
  const sandboxRequested = (sandboxMandatory || sandbox) && process.platform !== 'win32' && sandboxAvailable(backend);

  // Non-sandboxed host spawns exec on the host, not in the sandbox: a bare
  // `command` resolved against SANDBOX_PATH may not resolve on the server
  // process's own PATH (e.g. a ~/.local/bin install with a GUI/systemd PATH
  // that lacks it), and the child then dies immediately with exit 1 and no
  // output. Prefer the resolved absolute host path there (see resolveApp's
  // hostCommand); sandboxed launches keep the bare name their own PATH
  // resolves, so this never touches the sandbox branches below.
  if (!shell && !sandboxRequested && resolved.hostCommand) {
    command = resolved.hostCommand;
  }

  // Defensive backstop for the above: resolveApp always supplies hostCommand
  // when found, so a bare host-spawn name here means something regressed --
  // refuse with a clear message instead of an opaque immediate exit 1. Kept
  // under the "Failed to spawn" prefix (not "Cannot launch: <app> ...", which
  // INFRA_ERROR_PREFIXES reserves for request-as-given rejections) so this
  // server-side PATH misconfiguration classifies as an infra fault (500),
  // not a 400 -- see isInfrastructureError / sessionManager tests.
  if (!shell && !sandboxRequested && !command.includes('/') && process.platform !== 'win32') {
    const onHostPath = (process.env.PATH || '').split(':').some((dir) => {
      if (!dir) return false;
      try {
        const st = statSync(join(dir, command));
        return st.isFile() && (st.mode & 0o111);
      } catch { return false; }
    });
    if (!onHostPath) {
      return {
        sessionId: id,
        session: null,
        error: `Failed to spawn "${command}": not on the server's host PATH (resolved via the sandbox PATH `
          + `instead). Add ${sessionApp}'s install dir to the server's PATH before starting the server.`,
      };
    }
  }

  // An explicitly requested sandbox that cannot be built is refused instead
  // of silently falling back to a direct (unsandboxed) spawn: running on the
  // host while the client believes it is sandboxed is worse than an error.
  // (forceSandbox refusals keep their own message in the spawn branches
  // below, so this only covers the non-forced explicit request.)
  if (sandbox && !forceSandbox && !sandboxRequested) {
    const { reason, hint } = sandboxUnavailableReason(backend);
    return {
      sessionId: id,
      session: null,
      error: `Failed to build sandbox: ${reason}. ${hint}`,
    };
  }

  const mcpBridgeMode = sandboxRequested ? 'sandbox' : 'host';

  // Tool provisioning (rtk / code-review-graph): the server config supplies
  // the fallback default and the client's per-session sandboxOpts.tools (which
  // the launch menu defaults to ON for these, remembered per directory)
  // overrides it. The tools are provisioned into the sandbox HOME at launch,
  // so they are only ever injected when this session is actually sandboxed.
  // Thread cfg.tools through: the config was already read once above, so
  // resolveTools must not re-read + re-parse it here on every launch.
  const tools = resolveTools(sandboxOpts, cfg.tools);

  // MCP config injection -- never written to a file (see mcpConfig.js).
  // notify-enabled sessions get ccserver-notify, whose bridge command depends on
  // whether this session ends up sandboxed (the fixed in-sandbox path vs. the
  // host node+bridge). The args must be in the target command before
  // buildSandboxSpawn runs, so the mode is derived from sandboxRequested.
  let mcpEnv = {};
  // code-review-graph is only provisionable under bwrap (mount-bound
  // provisioner); the qemu VM never gets the binary, so injecting the
  // MCP server there would fail every session.
  const crgInjectable = sandboxRequested && backend !== 'qemu' && tools.codeReviewGraph;
  if (sessionApp && (useNotify || useUsage || crgInjectable)) {
    const injected = buildMcpConfigArgsAndEnv(sessionApp, {
      notify: useNotify ? {
        mode: mcpBridgeMode,
        sockPath: notifySocketPath,
        identity: notifyIdentity,
      } : undefined,
      usage: useUsage ? {
        mode: mcpBridgeMode,
        sockPath: usageSocketPath,
      } : undefined,
      // code-review-graph MCP is injected only into sandboxed sessions that
      // can actually provision it (sandboxed sessions only).
      tools: crgInjectable ? tools : null,
      cwd,
    });
    mcpEnv = injected.env;
    args.push(...injected.args);
  }

  // Agent notification bridge (plan-notify-bridge): make the CLI emit the
  // notification escape sequences the detector reads back off the pty. Returns
  // nothing at all unless the feature is on AND this app was selected AND
  // injectConfig is set, so a disabled bridge leaves the command line
  // byte-for-byte as it was before the feature existed (see
  // agentNotifyConfig.js's "OFF INVARIANT"). cfg was already read at the top of
  // createSession -- do not re-read the config file here.
  const notifyBridgeCfg = cfg.notify?.bridge || null;
  const agentNotify = sessionUi === 'chat' ? { args: [], env: {} } : buildAgentNotifyArgsAndEnv(sessionApp, notifyBridgeCfg);
  args.push(...agentNotify.args);

  // Optionally wrap the target in a bwrap filesystem sandbox.
  // See sandbox.js.
  let useSandbox = false;
  let sandboxDocker = false;
  let gpgVaultActive = false;
  let sandboxStateDir = null;
  let sandboxGitBrokerProc = null;
  let sandboxGitBrokerDir = null;
  let sandboxCommitGuardDir = null;
  let qemuRunDir = null;
  let qemuPoolLease = null;
  let qemuVm = null;
  // Network-isolation broker (qemu backend, Go broker): adminSock/armed/mode
  // are plain data needed here (the running-session toggle and
  // pushNetworkPolicyToArmedSessions make live calls to the broker straight
  // from this process). sandboxNetworkBrokerProc/Dir are the process
  // handle/runtime dir to kill/remove on teardown, same as
  // sandboxGitBrokerProc/Dir.
  let networkBrokerAdminSock = null;
  let networkIsolateArmed = false;
  let networkIsolateMode = null;
  let networkExtraAllowedHosts = [];
  let sandboxNetworkBrokerProc = null;
  let sandboxNetworkBrokerDir = null;
  let ptyProcess;

  // Chat mode: the dir holding the bridge's password and relay socket (and,
  // for Claude Code, the bridge itself). Made here, after every refusal
  // above that needs no cleanup; each failure below removes it.
  let chatDir = null;
  if (sessionUi === 'chat') {
    try {
      chatDir = prepareChatDir(id, { app: sessionApp, resumeLast, resumeId: claudeSessionId || null });
    } catch (err) {
      return { sessionId: id, session: null, error: `Failed to prepare the chat session: ${err.message}` };
    }
  }

  if (sandboxRequested) {
    // A fresh (wipe) sandbox is refused while another sandbox of the same
    // project is still using the same persistent HOME -- deleting the host dir
    // under a live bind mount would corrupt that session. The client disables
    // the "new" option in the same situation (GET /api/sandbox/status), so
    // this is the authoritative backstop.
    let reservedSandboxHomePath = null;
    if (cfg.persistentHome) {
      const targetPath = persistentHomeDir(cwd);
      // Every persistent-HOME launch reserves the path across the async
      // sandbox build. Reuse launches may coexist, but a fresh launch (which
      // wipes the old HOME) must reject both live sessions and launches that
      // have not reached sessions.set() yet.
      if (!sandboxHomeLaunchReservations.reserve(targetPath, {
        fresh: !reuseSandboxHome,
        liveSessions: sessions.values(),
      })) {
        removeChatDir(chatDir?.dir);
        return {
          sessionId: id,
          session: null,
          error: 'このプロジェクトのサンドボックスを利用中のセッションがあるため、新規作成（前回環境の破棄）できません。先にタブを閉じてください。',
        };
      }
      reservedSandboxHomePath = targetPath;
    }
    try {
      const spawn = await buildSandboxSpawn({ cwd, targetCommand: [command, ...args], app: sessionApp, sandboxOpts, notifySocketPath, usageSocketPath, reuseSandboxHome, sandboxHomeCreatedBy, chat: chatDir ? { hostDir: chatDir.dir, bridgeScript: chatDir.bridgeScript, bridgeArgs: chatDir.bridgeArgs } : null });
      command = spawn.command;
      args = spawn.args;
      sandboxDocker = !!spawn.docker;
      gpgVaultActive = !!spawn.gpgVaultActive;
      sandboxStateDir = spawn.stateDir || null;
      sandboxGitBrokerProc = spawn.gitBrokerProc || null;
      sandboxGitBrokerDir = spawn.gitBrokerDir || null;
      sandboxCommitGuardDir = spawn.commitGuardDir || null;
      qemuRunDir = spawn.qemuRunDir || null;
      qemuPoolLease = spawn.qemuPoolLease || null;
      qemuVm = spawn.qemuVm || null;
      networkBrokerAdminSock = spawn.networkBrokerAdminSock || null;
      networkIsolateArmed = !!spawn.networkIsolateArmed;
      networkIsolateMode = spawn.networkIsolateMode || null;
      networkExtraAllowedHosts = spawn.networkExtraAllowedHosts || [];
      sandboxNetworkBrokerProc = spawn.sandboxNetworkBrokerProc || null;
      sandboxNetworkBrokerDir = spawn.sandboxNetworkBrokerDir || null;
      useSandbox = true;
    } catch (err) {
      removeChatDir(chatDir?.dir);
      return { sessionId: id, session: null, error: `Failed to build sandbox: ${err.message}` };
    } finally {
      // After the await there is no further yield before pty.spawn and
      // buildSessionRecord's sessions.set(), so releasing here cannot expose
      // a successfully-built HOME between reservation and registration.
      sandboxHomeLaunchReservations.release(reservedSandboxHomePath);
    }
  } else if (sandboxMandatory) {
    // Two causes, two messages -- wording only (cfg.forceSandbox already
    // decided the outcome above). Keep the existing reason+hint
    // shape; the browseRoots one has its own INFRA_ERROR_PREFIXES entry
    // because the bwrap/disable-forceSandbox hint does not fit it.
    const { reason, hint } = forceSandboxUnavailableReason(backend);
    removeChatDir(chatDir?.dir);
    if (cfg.forceSandboxReason === 'config') {
      return {
        sessionId: id,
        session: null,
        error: `Cannot launch: sandbox.config.json sets "forceSandbox": true, but ${reason}. ${hint}`,
      };
    }
    return {
      sessionId: id,
      session: null,
      error: `Cannot launch: sandbox.config.json sets "browseRoots", so every session must run `
        + `sandboxed, but ${reason}. Install bwrap (bubblewrap) or unset browseRoots.`,
    };
  }

  // An unsandboxed chat launch runs the bridge on the host itself (a
  // sandboxed one got it from buildSandboxSpawn).
  if (chatDir && !useSandbox) {
    [command, ...args] = chatBridgeArgv({
      node: process.execPath,
      script: chatDir.bridgeScript,
      sock: chatDir.sock,
      passwordFile: join(chatDir.dir, CHAT_PASSWORD_NAME),
      bridgeArgs: chatDir.bridgeArgs,
    }, [command, ...args]);
  }

  try {
    ptyProcess = pty.spawn(command, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      ...cleanEnv,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FORCE_COLOR: '1',
      // For claude sessions, keep it drawing to the main buffer instead of the
      // alternate screen (DECSET 1049). The alt-screen has no scrollback, so
      // xterm.js's scrollLines()/scroll buttons do nothing while it's active;
      // disabling it lets scrollback accumulate again. DISABLE_MOUSE_CLICKS
      // additionally hands the scroll wheel back to xterm.js. Only affects
      // ccserver-launched claude; shells are left untouched.
      ...(shell || sessionApp !== 'claude' ? {} : {
        CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
        CLAUDE_CODE_DISABLE_MOUSE_CLICKS: '1',
      }),
      // opencode is left with full mouse capture (its default): the TUI keeps
      // the whole conversation in an internal scrollable area that the wheel
      // scrolls natively, and its own drag-selection + copy-on-select writes
      // to the browser clipboard via OSC 52 (handled client-side).
      ...mcpEnv,
      ...agentNotify.env,
      // /tmp being mounted noexec makes Bun fail to unpack + dlopen its
      // embedded libopentui.so, so opencode's TUI dies at startup (opencode
      // #26136/#27580). Direct host launches switch BUN_TMPDIR to
      // ~/.cache/opencode/tmp when the host TMPDIR is noexec. Sandboxed
      // launches don't: the sandbox's /tmp is a fresh tmpfs that is always
      // executable, and the host-side cache dir is not bound into bwrap (with
      // a fresh HOME it would not even exist), so setting it there would
      // break what it is meant to fix.
      ...(shell || sessionApp !== 'opencode' || useSandbox ? {} : bunTmpdirEnv()),
    },
  });
  } catch (err) {
    // The sandbox (if any) was already built by this point -- clean up what
    // buildSandboxSpawn created (brokers, guard/profile dirs). Otherwise a
    // failed launch leaks a live broker process and its runtime dirs. (The
    // failed session itself was never registered, so no self-exclusion is
    // needed -- see releaseSandboxArtifacts.)
    releaseSandboxArtifacts({
      sandboxStateDir, sandboxGitBrokerProc, sandboxGitBrokerDir, sandboxCommitGuardDir,
      sandboxNetworkBrokerProc, sandboxNetworkBrokerDir, qemuRunDir, qemuPoolLease,
      chat: chatDir,
    });
    return { sessionId: id, session: null, error: `Failed to spawn "${command}": ${err.message}` };
  }

  const session = buildSessionRecord(id, ptyProcess, {
    cwd,
    shell,
    app: sessionApp,
    model: sessionModel,
    permissionMode: sessionPermissionMode,
    ui: sessionUi,
    chat: chatDir ? createChatState({
      ...chatDir,
      app: sessionApp,
      sandboxed: useSandbox,
      backend: useSandbox ? backend : null,
      pooled: !!qemuPoolLease,
      resumeLast,
      model: sessionModel,
      defaultModel: getChatDefaultModel(sessionApp),
    }) : null,
    customLabel,
    sandbox: useSandbox,
    sandboxOpts,
    docker: sandboxDocker,
    gpgVaultActive,
    sandboxStateDir,
    sandboxGitBrokerProc,
    sandboxGitBrokerDir,
    sandboxCommitGuardDir,
    qemuRunDir,
    qemuPoolLease,
    qemuVm,
    sandboxBackend: sandboxRequested ? backend : null,
    networkBrokerAdminSock,
    networkIsolateArmed,
    networkIsolateMode,
    networkExtraAllowedHosts,
    sandboxNetworkBrokerProc,
    sandboxNetworkBrokerDir,
    reuseSandboxHome,
    cols,
    rows,
    startedClaudeSessionId: claudeSessionId || null,
  });

  // Arm the notification capture. Decided once, here, rather than per pty
  // chunk: loadSandboxConfig() re-reads and re-parses the config file on every
  // call, and onData is the hottest path in the server. A session launched
  // with the bridge off simply has no detector, so the onData hook below costs
  // one property check. (Delivery-side settings -- channels, rate limits --
  // ARE re-read per notification, which is rare; see notifyBridge.js.)
  if (shouldCaptureNotifications({ shell, app: sessionApp, bridge: notifyBridgeCfg })) {
    // A chat session's notifications come from its event stream (see the
    // chat monitor above), not from pty escape sequences.
    if (sessionUi === 'chat') session.chatNotify = true;
    else attachNotifyDetector(session, notifyBridgeCfg);
  }

  return { sessionId: id, session };
}

// A VM Terminal (Settings GUI, running VMs): a login shell on the running
// persistent VM `vmId`, outside the guest bwrap (qemuVmPool attachShell).
// Only the browser's own WebSocket reaches this (terminal.js init with
// vmShellId) -- never REST or MCP launches, which would let a sandboxed
// agent step out of the guest confinement.
export async function createVmShellSession({ vmId, cols, rows }) {
  const id = randomUUID();
  const home = homedir();
  let lease;
  try {
    lease = await qemuVmPool.attachShell(vmId, { home });
  } catch (err) {
    return { sessionId: id, session: null, error: `Failed to open the VM terminal: ${err.message}` };
  }
  let ptyProcess;
  try {
    ptyProcess = pty.spawn(process.execPath, [QEMU_LAUNCHER, lease.planPath], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: home,
      env: { ...buildSessionEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '1' },
    });
  } catch (err) {
    releaseSandboxArtifacts({ qemuPoolLease: lease });
    return { sessionId: id, session: null, error: `Failed to spawn the VM terminal: ${err.message}` };
  }
  const session = buildSessionRecord(id, ptyProcess, {
    cwd: home,
    shell: true,
    app: null,
    model: null,
    sandbox: true,
    sandboxOpts: { backend: 'qemu', vmShellId: vmId },
    sandboxBackend: 'qemu',
    qemuPoolLease: lease,
    qemuVm: { ...lease.vm.info, pooled: true, vmId: lease.vm.id, startedAt: lease.vm.startedAt, vmShell: true },
    // The same VM-wide network toggle as the VM's agent sessions
    // (setPooledVmNetworkMode).
    networkBrokerAdminSock: lease.vm.network?.adminSock ?? null,
    networkIsolateArmed: !!lease.vm.network,
    networkIsolateMode: lease.vm.network?.mode ?? null,
    cols,
    rows,
  });
  return { sessionId: id, session };
}

// Aggregate detector counters across every armed session (review finding F4:
// these were incremented but unreachable -- documented as an observability
// pillar with no way to observe them). Served by GET /api/notify-settings.
// `armed` is how many sessions are actually being watched, which is the first
// thing to check when notifications are not arriving.
export function notifyDetectorStats() {
  const total = { armed: 0, evictedKitty: 0, truncatedKitty: 0, overflowed: 0, aborted: 0 };
  for (const session of sessions.values()) {
    if (!session.notifyDetector) continue;
    total.armed += 1;
    const s = session.notifyDetector.stats();
    for (const k of ['evictedKitty', 'truncatedKitty', 'overflowed', 'aborted']) total[k] += s[k] || 0;
  }
  return total;
}

export function getSession(id) {
  return sessions.get(id);
}

// Operator-assigned display names for sessions (right-click rename in the
// client). Null/undefined/empty-after-trim means "no custom name". Overlong
// input is rejected (not truncated) so the caller can surface the limit.
export const MAX_CUSTOM_LABEL_LENGTH = 64;

export function normalizeCustomLabel(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  // Strip ASCII + C1 control characters and U+2028/U+2029 line separators --
  // the label is rendered in single-line UI slots (session rows, terminal
  // header), where they would split lines or break layout.
  const cleaned = value.replace(/[\u0000-\u001F\u007F\u0080-\u009F\u2028\u2029]/g, '').trim();
  if (!cleaned) return null;
  return cleaned;
}

export function setSessionLabel(id, label) {
  const session = sessions.get(id);
  if (!session) {
    return { ok: false, code: 'not-found', message: 'Session not found' };
  }
  if (label !== null && label !== undefined && typeof label !== 'string') {
    return { ok: false, code: 'validation', message: 'customLabel must be a string or null' };
  }
  const normalized = normalizeCustomLabel(label);
  if (normalized !== null && [...normalized].length > MAX_CUSTOM_LABEL_LENGTH) {
    return { ok: false, code: 'validation', message: `customLabel must be at most ${MAX_CUSTOM_LABEL_LENGTH} characters` };
  }
  session.customLabel = normalized;
  return { ok: true, session };
}

// Write text into a live session's pty, optionally submitting with Enter.
// Shared by the WS 'input' path (terminal.js) and the MCP send_input tool
// Idle timer reset mirrors the WS input handler.
export function writeToSession(id, text, { submit = false } = {}) {
  const session = sessions.get(id);
  if (!session?.ptyProcess || session.exited) return false;
  // A chat session has no TUI to type into: text accumulates until a submit
  // sends it as one prompt over the API.
  if (session.chat) {
    if (!session.chat.ready) return false;
    session.chatPendingInput = (session.chatPendingInput || '') + text;
    if (submit) {
      const prompt = session.chatPendingInput;
      session.chatPendingInput = '';
      if (prompt.trim()) {
        sendChatPrompt(session.chat, prompt).catch((err) => console.warn(`[chat] ${id}: prompt failed: ${err.message}`));
      }
    }
    return true;
  }
  try {
    session.ptyProcess.write(text);
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    if (submit) {
      // Delay the Enter so the TUI registers the text first (same pattern as
      // injectIntoLiveSession). The key resolves through the per-app submit
      // table (appLaunch.appSubmitKey) -- never a literal here -- so an app
      // that ever needs a different submit byte changes only that table.
      setTimeout(() => {
        if (!session.exited && session.ptyProcess) {
          try {
            session.ptyProcess.write(appSubmitKey(session.app));
          } catch {
            // pty may have died between writes
          }
        }
      }, 200);
    }
    return true;
  } catch {
    return false;
  }
}

// Named control keys writable via writeKeyToSession (MCP send_key). This is
// deliberately a WHITELIST of exact byte sequences, never a generic raw-input
// API: arbitrary strings, ANSI sequences, Ctrl-C/Ctrl-D or arrow keys are not
// exposed, so this path can dismiss an agent TUI's confirmation modal but can
// never stop/kill the worker's shell or drive its UI beyond that.
const SESSION_KEYS = {
  escape: '\x1b',
};

// Write ONE whitelisted control key into a live session's pty. Liveness check
// and idle-timer handling mirror writeToSession; unlike writeToSession there
// is no delayed submit -- a confirmation modal must close on the key itself,
// so no CR is appended.
export function writeKeyToSession(id, key) {
  const bytes = SESSION_KEYS[key];
  if (!bytes) return false;
  const session = sessions.get(id);
  if (!session?.ptyProcess || session.exited) return false;
  try {
    session.ptyProcess.write(bytes);
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    return true;
  } catch {
    return false;
  }
}

// Gate for tools that type into a freshly-launched agent TUI (send_input):
// wait until the session's output has gone idle (first IDLE_TIMEOUT_MS gap)
// so keystrokes aren't dropped by a TUI that is still initializing. Resolves
// immediately -- with the session's current settled state -- for sessions
// that can never settle (missing, exited, plain shell, already settled).
// Best-effort: callers write regardless of the outcome; a timed-out wait just
// reports { settled: false, timedOut: true } so the caller can re-check.
const SETTLE_WAIT_TIMEOUT_MS = 10 * 1000;

export function waitUntilSettled(id, { timeoutMs = SETTLE_WAIT_TIMEOUT_MS } = {}) {
  const session = sessions.get(id);
  if (!session || session.exited || session.shell || session.settled) {
    return Promise.resolve({ settled: !!session?.settled, timedOut: false });
  }
  return new Promise((resolve) => {
    let timer = null;
    const onSettled = () => {
      if (timer) clearTimeout(timer);
      resolve({ settled: true, timedOut: false });
    };
    session.settleWaiters.push(onSettled);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        const i = session.settleWaiters.indexOf(onSettled);
        if (i !== -1) {
          session.settleWaiters.splice(i, 1);
          resolve({ settled: false, timedOut: true });
        }
      }, timeoutMs);
    }
  });
}

const MAX_SCHEDULE_AHEAD_MS = 48 * 60 * 60 * 1000; // 48h

// Session-limit auto-resume detection (see sessionLimitDetect.js and the
// onData handler above). The status line is short, so a window well past its
// longest plausible rendering (including redraws/padding) is cheap to keep
// and to re-strip/re-match on every chunk.
const LIMIT_DETECT_BUF_MAX_CHARS = 2048;
const SESSION_LIMIT_RESUME_DELAY_MS = 60 * 1000; // fire 1 minute after reset
const SESSION_LIMIT_RESUME_MESSAGE = 'セッション制限がリセットされました。作業を続けてください。';

// The server's IANA timezone (e.g. "Asia/Tokyo"). Claude Code prints its
// rate-limit reset times in this zone, so scheduling is interpreted here too.
let SERVER_TZ = 'UTC';
try {
  SERVER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
} catch {
  // keep UTC fallback
}

export function getServerTimeInfo() {
  return { tz: SERVER_TZ, now: Date.now() };
}

// Convert an "HH:MM" wall-clock time in the SERVER's local timezone into the
// next matching absolute epoch (today if still ahead, otherwise tomorrow).
export function computeNextLocalTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target.getTime();
}

// Fire missed prompts up to this late after a restart; older ones are dropped.
const SCHEDULE_STALE_GRACE_MS = 12 * 60 * 60 * 1000; // 12h
// Safety net for delivering into a freshly-resumed session that never goes idle.
const RESUME_INJECT_FALLBACK_MS = 15 * 1000;

// scheduleId -> { at, text, cwd, sandbox, shell, claudeSessionId, sessionId, timer }
// The source of truth for scheduled prompts. Mirrored to disk so schedules
// survive a server restart/crash (see persistSchedules/restoreSchedules).
const schedules = new Map();

function persistSchedules() {
  try {
    const arr = [];
    for (const s of schedules.values()) {
      arr.push({
        at: s.at,
        text: s.text,
        cwd: s.cwd,
        sandbox: !!s.sandbox,
        sandboxOpts: s.sandboxOpts || null,
        shell: !!s.shell,
        app: s.app || 'claude',
        model: normalizeModel(s.model) || null,
        permissionMode: 'standard',
        ui: normalizeSessionUi(s.ui),
        claudeSessionId: s.claudeSessionId || null,
        source: s.source || 'manual',
      });
    }
    if (arr.length > 0) {
      writeFileSync(schedulesPath(), JSON.stringify(arr));
    } else {
      try { unlinkSync(schedulesPath()); } catch { /* nothing to remove */ }
    }
  } catch {
    // best effort — persistence must never crash the session manager
  }
}

// Best-known conversation id for resuming this session later.
function resumeIdForSession(session) {
  if (!session) return null;
  if (session.claudeSessionId) return session.claudeSessionId;
  const extracted = extractResumeId(session);
  if (extracted) return extracted;
  return session.startedClaudeSessionId || null;
}

function scheduleForSession(sessionId) {
  for (const [sid, s] of schedules) {
    if (s.sessionId === sessionId) return sid;
  }
  return null;
}

// Public (serializable) view of a session's scheduled prompt
export function scheduledPromptPublic(session) {
  if (!session?.scheduleId) return null;
  const s = schedules.get(session.scheduleId);
  return s ? { at: s.at, text: s.text, source: s.source } : null;
}

// Does any live, sandboxed session share `targetPath` as its persistent HOME?
// Used to refuse a "new sandbox" (wipe) while another sandbox of the same
// project is still using it: deleting the host dir under an active bind mount
// would corrupt that session's HOME. Unsandboxed sessions don't bind the
// persistent HOME and are unaffected. Exported for unit testing -- pure over
// the live-session list.
export function sandboxHomeConflict(targetPath, liveSessions) {
  for (const s of liveSessions) {
    if (!s || s.exited || !s.sandbox) continue;
    if (persistentHomeDir(s.cwd) === targetPath) return true;
  }
  return false;
}

// Whether THIS session can actually use docker right now -- surfaced by
// the session UI can show availability before a task runs. A live rootless dockerd is
// only ever able to hold ONE project's data-root at a time (see
// sandbox-entrypoint.sh's flock); a second sandbox of the same project
// launches with docker: false internally rather than corrupting that
// data-root, and Node never previously tracked whether the flock was
// actually won.
//
//   dockerAvailable  dockerReason                          meaning
//   null             'not-sandboxed'                       no sandbox, docker N/A
//   false            'tooling-missing'                     bwrap/rootlesskit/etc not installed
//   false            'disabled-by-config'                  sandbox.config.json docker:false
//   null             'starting'                            docker enabled, dockerd hasn't won/lost the flock yet -- retry shortly
//   true             'available'                           this session's own dockerd holds the data-root lock
//   false            'data-root-locked-by-another-session'  a different session's dockerd holds it
//
// A tag mismatch alone doesn't prove "another session has it": the status
// file is never cleared on exit, so it can just as well be leftover from a
// session that has since fully exited (see DOCKERD_STATUS_NAME in
// sandbox.js). dockerdLockHeld() disambiguates by checking whether the flock
// is actually held right now -- if not, this is still just an unresolved
// "starting" (this session's own dockerd hasn't raced for the flock yet),
// not a hard conflict worth diverting the task elsewhere.
//
// Exported for unit testing -- pure over a session-shaped object (only
// .sandbox/.docker/.dockerTag/.cwd are read).
export function dockerAvailability(session) {
  if (!session?.sandbox) return { dockerAvailable: null, dockerReason: 'not-sandboxed' };
  if (!session.docker) {
    return { dockerAvailable: false, dockerReason: dockerSandboxAvailable() ? 'disabled-by-config' : 'tooling-missing' };
  }
  const status = dockerdStatus(session.cwd);
  if (status === session.dockerTag) return { dockerAvailable: true, dockerReason: 'available' };
  if (status && dockerdLockHeld(session.cwd)) return { dockerAvailable: false, dockerReason: 'data-root-locked-by-another-session' };
  return { dockerAvailable: null, dockerReason: 'starting' };
}

// Count of live sandboxed sessions sharing cwd's persistent HOME. Surfaced by
// GET /api/sandbox/status so the client can disable the destructive "new"
// option while the project's sandbox is in use.
export function sandboxHomeInUse(cwd) {
  return sandboxHomeInUsePath(persistentHomeDir(cwd));
}

// Count of live sandboxed sessions whose persistent HOME is exactly
// `homePath`. Backs the settings page (GET /api/sandboxes) and the delete
// guard: a sandbox that is currently mounted by a live session must not be
// deleted from under it.
export function sandboxHomeInUsePath(homePath) {
  let n = sandboxHomeLaunchReservations.count(homePath);
  for (const s of sessions.values()) {
    if (sandboxHomeConflict(homePath, [s])) n++;
  }
  return n;
}

// Shared message shape for the network-isolation globe toggle (see
// TerminalView.jsx): `armed` is fixed for the session's whole life (whether
// a broker/boundary exists at all -- decided at launch), `enabled` is the
// live enforce/open policy, flippable anytime via set_network_isolation
// without a sandbox restart. `scope` is 'vm' for a persistent VM, whose one
// broker serves every session on it, so a flip applies to all of them.
export function networkIsolationStateMsg(session) {
  return {
    type: 'network_isolation_state',
    armed: !!session.networkIsolateArmed,
    enabled: session.networkIsolateMode === 'enforce',
    scope: session.qemuVm?.pooled ? 'vm' : 'session',
  };
}

// The running-session toggle on a persistent VM: sets the VM's broker to
// `mode` and, on success, updates and notifies every session on that VM.
export async function setPooledVmNetworkMode(vmId, mode) {
  if (!(await qemuVmPool.setNetworkMode(vmId, mode))) return false;
  for (const s of sessions.values()) {
    if (!s.qemuVm?.pooled || s.qemuVm.vmId !== vmId) continue;
    s.networkIsolateMode = mode;
    broadcast(s, networkIsolationStateMsg(s));
  }
  return true;
}

// Pushes a replacement allow/deny-list and operating mode (enforce/audit) to
// every live session that has network isolation enabled (qemu backend, Go
// broker): the Settings GUI's save path (server/routes/networkAllowlist.js)
// calls this so a running session's egress policy updates without a restart.
// A session counts as applied only when both the lists and the mode landed.
// Fails soft per session -- one dead/unreachable broker (session exiting mid-push, race with
// teardown) must not stop the rest, and the file save itself already
// succeeded regardless. The admin socket is plain data on the session
// record (see buildSessionRecord), so the call is made straight from this
// process.
export async function pushNetworkPolicyToArmedSessions({ allowedHosts, deniedHosts, mode }) {
  // Not a persistent VM's sessions: their lists and mode are the VM's
  // broker's and are set per VM below.
  const armed = [...sessions.values()].filter((s) => brokerArmed(s) && !s.qemuVm?.pooled);
  // Parallel, not sequential: each session's push is an independent HTTP
  // round-trip to a different broker process, so awaiting them one at a time
  // in a for...of would block the Settings PUT handler (which awaits this)
  // for up to N round-trips instead of max(). One dead/unreachable broker
  // (session exiting mid-push, race with teardown) must not stop the rest --
  // same fail-soft posture as before, just concurrent.
  const results = await Promise.all(armed.map(async (s) => {
    try {
      const extra = s.networkExtraAllowedHosts.filter((h) => !allowedHosts.includes(h));
      const [lists, opMode] = await Promise.all([
        setSessionBrokerLists(s, { allowedHosts: [...allowedHosts, ...extra], deniedHosts }),
        mode === undefined ? true : setSessionBrokerOpMode(s, mode),
      ]);
      return lists && opMode;
    } catch {
      return false;
    }
  }));
  let ok = 0;
  let failed = 0;
  for (const applied of results) {
    if (applied) ok++; else failed++;
  }
  // Counted in sessions like the rest: every session on a VM shares its
  // broker, so a VM's result applies to each of them. A VM counts as applied
  // only when both the lists and the mode landed.
  const vmApplied = new Map();
  const vmPushes = [
    qemuVmPool.setListsAll({ allowedHosts, deniedHosts }),
    mode === undefined ? [] : qemuVmPool.setOpModeAll(mode),
  ];
  for (const p of vmPushes) {
    let vmResults = [];
    try { vmResults = await p; } catch { /* counted as nothing applied */ }
    for (const { id, ok: applied } of vmResults) vmApplied.set(id, (vmApplied.get(id) ?? true) && applied);
  }
  for (const s of sessions.values()) {
    if (!s.qemuVm?.pooled || !vmApplied.has(s.qemuVm.vmId)) continue;
    if (vmApplied.get(s.qemuVm.vmId)) ok++; else failed++;
  }
  return { ok, failed };
}

// Detach the schedule from a session that's going away, but keep it armed so it
// auto-resumes the conversation at fire time.
function detachScheduleFromSession(sessionId) {
  const sid = scheduleForSession(sessionId);
  if (sid == null) return;
  const s = schedules.get(sid);
  if (s) s.sessionId = null;
  const session = sessions.get(sessionId);
  if (session) session.scheduleId = null;
}

function refreshScheduleOnExit(session) {
  const sid = scheduleForSession(session.id);
  if (sid == null) return;
  const s = schedules.get(sid);
  if (!s) return;
  const freshId = resumeIdForSession(session);
  if (freshId) s.claudeSessionId = freshId;
  s.sessionId = null; // the pty is gone; force the resume path at fire time
  session.scheduleId = null;
  persistSchedules();
}

function injectIntoLiveSession(session, text) {
  if (session.chat) {
    if (!session.chat.ready) return false;
    sendChatPrompt(session.chat, text).catch((err) => console.warn(`[chat] ${session.id}: prompt failed: ${err.message}`));
    return true;
  }
  try {
    // Type the prompt text, then submit with Enter after a short delay so the
    // TUI registers the input before the newline is sent.
    session.ptyProcess.write(text);
    setTimeout(() => {
      if (!session.exited && session.ptyProcess) {
        try {
          session.ptyProcess.write('\r');
        } catch {
          // pty may have died between writes
        }
      }
    }, 200);
    return true;
  } catch {
    return false;
  }
}

// Build a schedule_state payload including server timezone info so the client
// can display/interpret times in the server's zone (matching Claude Code).
// Exported so terminal.js's WS-request handlers (schedule_prompt,
// cancel_schedule, get_schedule, init, attach) can reuse the same payload
// shape as the server-internal push paths below.
export function buildScheduleStateMsg(scheduled, error) {
  const { tz, now } = getServerTimeInfo();
  return JSON.stringify({
    type: 'schedule_state',
    scheduled,
    serverTz: tz,
    serverNow: now,
    ...(error ? { error } : {}),
  });
}

// Push the current schedule state to every attached viewer. Needed by any
// server-internal path that arms/changes a schedule without a client request
// to respond to (e.g. the auto-session-limit detector in onData) -- unlike
// schedule_prompt/cancel_schedule/get_schedule, those paths have no
// request/response leg to piggyback the push on.
function notifyScheduleState(session) {
  if (!session) return;
  broadcast(session, buildScheduleStateMsg(scheduledPromptPublic(session)));
}

function notifyFired(session, info, delivered) {
  if (!session) return;
  broadcast(session, {
    type: 'schedule_fired',
    at: info.at,
    text: info.text,
    delivered,
  });
  broadcast(session, { type: 'schedule_state', scheduled: null });
}

// Schedule-entry matching for the "same project" live-session substitution
// (fireSchedule branch 2). A model-annotated schedule must only inject into a
// session launched with the SAME model; unmodeled entries (both null) keep
// the original cwd+shell+app semantics. The same rule applies to the
// permission mode: a yolo/auto-accept schedule must not inject into a
// standard session (legacy entries without the field count as 'standard').
// Exported for direct unit testing.
export function matchesScheduleTarget(session, entry) {
  return !!session && !session.exited && !!session.ptyProcess
    && session.cwd === entry.cwd
    && session.shell === entry.shell
    && session.app === entry.app
    && (session.model ?? null) === (entry.model ?? null)
    && (session.permissionMode ?? 'standard') === (entry.permissionMode ?? 'standard')
    && normalizeSessionUi(session.ui) === normalizeSessionUi(entry.ui);
}

async function fireSchedule(scheduleId) {
  const entry = schedules.get(scheduleId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  schedules.delete(scheduleId);
  persistSchedules();

  // 1) The originating session, if still alive.
  let target = entry.sessionId ? sessions.get(entry.sessionId) : null;
  if (target && (target.exited || !target.ptyProcess)) target = null;

  // 2) Otherwise any live session for the same project (user reopened it).
  if (!target) {
    for (const s of sessions.values()) {
      if (matchesScheduleTarget(s, entry)) {
        target = s;
        break;
      }
    }
  }

  if (target) {
    if (target.scheduleId === scheduleId) target.scheduleId = null;
    const delivered = injectIntoLiveSession(target, entry.text);
    notifyFired(target, entry, delivered);
    return;
  }

  // 3) No live session — auto-resume the conversation, then inject once ready.
  // opencode and codex expose no session id in their TUI output, so resume the
  // last session of the project instead of a specific one.
  const cwd = entry.cwd;
  const res = await createSession({
    cwd,
    cols: 80,
    rows: 24,
    claudeSessionId: entry.claudeSessionId,
    shell: entry.shell,
    sandbox: entry.sandbox,
    sandboxOpts: entry.sandboxOpts,
    app: entry.app,
    model: entry.model,
    permissionMode: entry.permissionMode,
    resumeLast: entry.app === 'opencode' || entry.app === 'codex',
    ui: normalizeSessionUi(entry.ui),
  });
  if (!res?.session) {
    // Explain auto-resume failures because there is no client request to
    // receive the error: a hiddenApps rejection (or
    // any other createSession() failure -- not-installed, invalid cwd) must
    // not disappear silently just because this is the auto-resume path
    // rather than a live launch request with a client to report the error to.
    console.warn(`[scheduler] dropping prompt for schedule ${scheduleId}: ${res?.error || 'createSession failed'}`);
    return;
  }
  const session = res.session;
  session.pendingInjection = { text: entry.text, at: entry.at };
  // Safety net: deliver even if the session never emits an idle gap (e.g. a
  // plain shell). The idle path normally fires first for Claude sessions.
  // Tracked on the session so a destroyed one doesn't keep a dead timer
  // armed (it no-ops, but holds the event loop in tests and lingers in prod).
  session.pendingInjectionTimer = setTimeout(() => {
    if (session.exited || !session.pendingInjection) return;
    const inj = session.pendingInjection;
    session.pendingInjection = null;
    session.pendingInjectionTimer = null;
    const delivered = injectIntoLiveSession(session, inj.text);
    notifyFired(session, inj, delivered);
  }, RESUME_INJECT_FALLBACK_MS);
}

// Schedule a prompt to be injected at absolute epoch `at`. Returns the public
// view on success, or null if the time is invalid (past / too far ahead).
// `source` distinguishes a user-set schedule ('manual', the default, set via
// the browser's clock panel) from one the session-limit auto-detector armed
// ('auto-session-limit') -- see the onData handler below, which uses this to
// avoid clobbering a manual schedule.
export function setScheduledPrompt(id, at, text, { source = 'manual' } = {}) {
  const session = sessions.get(id);
  if (!session) return null;

  const delay = at - Date.now();
  if (!Number.isFinite(at) || delay <= 0 || delay > MAX_SCHEDULE_AHEAD_MS) {
    return null;
  }
  if (typeof text !== 'string' || text.length === 0) return null;

  // Replace any existing schedule for this session.
  cancelScheduledPrompt(id);

  const scheduleId = randomUUID();
  const entry = {
    at,
    text,
    cwd: session.cwd,
    sandbox: !!session.sandbox,
    sandboxOpts: session.sandboxOpts || null,
    shell: !!session.shell,
    app: session.app || 'claude',
    model: normalizeModel(session.model) || null,
    permissionMode: 'standard',
    ui: normalizeSessionUi(session.ui),
    claudeSessionId: resumeIdForSession(session),
    sessionId: id,
    source,
    timer: setTimeout(() => fireSchedule(scheduleId), delay),
  };
  schedules.set(scheduleId, entry);
  session.scheduleId = scheduleId;
  persistSchedules();
  return { at, text, source };
}

export function cancelScheduledPrompt(id) {
  const sid = scheduleForSession(id);
  if (sid == null) return;
  const s = schedules.get(sid);
  if (s?.timer) clearTimeout(s.timer);
  schedules.delete(sid);
  const session = sessions.get(id);
  if (session) session.scheduleId = null;
  persistSchedules();
}

// Re-arm persisted schedules on server startup. Future ones get a fresh timer;
// ones missed while the server was down fire shortly after startup (unless too
// stale). No session is spawned now — that happens lazily at fire time.
export function restoreSchedules() {
  let arr;
  try {
    arr = readJsonFileIfRegular(schedulesPath());
  } catch {
    return; // no file / unreadable
  }
  if (!Array.isArray(arr)) return;

  const now = Date.now();
  let restored = 0;
  let missed = 0;
  for (const e of arr) {
    if (!e || typeof e.text !== 'string' || !Number.isFinite(e.at)) continue;
    if (e.groupId || e.groupRole) continue; // retired combo-member schedules must not become standalone launches
    if (e.at > now + MAX_SCHEDULE_AHEAD_MS) continue; // implausibly far ahead

    const delay = e.at - now;
    if (delay <= 0 && now - e.at > SCHEDULE_STALE_GRACE_MS) continue; // too old, drop

    const scheduleId = randomUUID();
    const entry = {
      at: e.at,
      text: e.text,
      cwd: e.cwd,
      sandbox: !!e.sandbox,
      sandboxOpts: e.sandboxOpts || null,
      shell: !!e.shell,
      // Legacy persisted schedules predate the app field and were claude.
      app: isValidApp(e.app) ? e.app : 'claude',
      // Legacy schedules predate the model field; null means the app default.
      model: normalizeModel(e.model) || null,
      // Legacy schedules predate the permissionMode field; 'standard' (no
      // flag) is the safe direction.
      permissionMode: 'standard',
      // Legacy schedules predate chat mode: a terminal.
      ui: normalizeSessionUi(e.ui),
      claudeSessionId: e.claudeSessionId || null,
      // Legacy entries (no source field) fall back to 'manual' -- the safe
      // direction, since a manual schedule is protected from being clobbered
      // by the auto-detector while an 'auto-session-limit' one is not (see
      // the onData handler).
      source: e.source === 'auto-session-limit' ? 'auto-session-limit' : 'manual',
      sessionId: null,
      timer: null,
    };
    // Missed schedules fire a few seconds after startup so the server can finish
    // booting; future ones fire at their time.
    const fireIn = delay <= 0 ? 3000 : delay;
    entry.timer = setTimeout(() => fireSchedule(scheduleId), fireIn);
    schedules.set(scheduleId, entry);
    restored++;
    if (delay <= 0) missed++;
  }
  persistSchedules(); // rewrite the pruned set
  return { restored, missed };
}

// Close the current dirty-row slice if SAMPLE_MS has passed, banking it in
// the session's ring. Called from the output path (so a busy session samples
// at its own cadence) and again from activitySnapshot (so a burst that ended
// mid-slice is not lost when nothing else arrives to trigger a sample).
function sampleScreenActivity(session, now = Date.now()) {
  if (!session?.screen) return;
  if (session.screenSampleAt == null) {
    // First data for this session: start the slice, nothing to bank yet.
    session.screenSampleAt = now;
    return;
  }
  if (now - session.screenSampleAt < SAMPLE_MS) return;
  session.screenSampleAt = now;
  // Two corrections before the slice is banked:
  //   - clamp, because a whole-screen change (a clear, an alternate-screen
  //     switch) is reported as every row the model holds -- up to its
  //     200-row scrollback cap, which is not a screen;
  //   - normalize for width, because the same output wraps into more rows on
  //     a narrow terminal than a wide one, and the thresholds were calibrated
  //     at REFERENCE_COLS.
  const rows = Math.min(session.screen.takeDirtyRowCount(), MAX_ROWS_PER_SAMPLE);
  session.screenSamples.push({ at: now, rows: normalizeRowsForWidth(rows, session.cols) });
  if (session.screenSamples.length > MAX_SAMPLES) session.screenSamples.shift();
}

// How active this session's agent is right now -- the tab colour's source of
// truth (see activity.js for the rules). Derived on READ, exactly like
// idleForMs/screenIdleMs: no timer runs to keep it fresh, and a session
// nobody looks at costs nothing.
//
// The one piece of state kept between reads is the previous level, which the
// red/yellow hysteresis needs; it is written back here so every reader
// (browser poll, MCP tool) advances the same history.
export function activitySnapshot(session) {
  if (!session) return NO_ACTIVITY;
  // Chat mode has no TUI screen to read: the chat monitor's state is exact.
  if (session.chat) {
    const base = { marker: null, markerVerified: true, screenIdleMs: null, changeRate: 0 };
    if (session.exited) return { ...base, level: null, reason: 'exited' };
    if (!session.chat.ready) return { ...base, level: 'low', reason: 'chat-starting' };
    if (session.chat.waiting > 0) return { ...base, level: 'idle', reason: 'chat-waiting' };
    return { ...base, level: session.chat.busy ? 'busy' : 'idle', reason: session.chat.busy ? 'chat-busy' : 'chat-idle' };
  }
  const now = Date.now();
  sampleScreenActivity(session, now);
  const round = (n) => Math.round(n * 10) / 10;
  const result = classifyActivity({
    app: session.app ?? null,
    live: true,
    exited: !!session.exited,
    shell: !!session.shell,
    screenRows: session.screen ? session.screen.screenRows() : null,
    screenIdleMs: session.screenLastChangeAt != null ? now - session.screenLastChangeAt : null,
    changeRate: round(changeRateFromSamples(session.screenSamples, now, RATE_WINDOW_MS)),
    holdRate: round(changeRateFromSamples(session.screenSamples, now, RATE_HOLD_WINDOW_MS)),
    previousLevel: session.activityLevel,
  });
  session.activityLevel = result.level;
  return result;
}

export function listSessions() {
  const result = [];
  for (const [id, session] of sessions) {
    if (session.exited) continue;
    result.push({
      id,
      cwd: session.cwd,
      connected: !!session.socket,
      shell: session.shell,
      sandbox: session.sandbox,
      sandboxOpts: session.sandboxOpts || null,
      sandboxBackend: session.sandboxBackend || null,
      gpgVaultActive: !!session.gpgVaultActive,
      app: session.app,
      model: session.model || null,
      permissionMode: 'standard',
      ui: session.ui || 'terminal',
      customLabel: session.customLabel || null,
      // How hard this session's agent is working right now (see activity.js):
      // { level: 'idle'|'low'|'busy'|null, reason, marker, markerVerified,
      // screenIdleMs, changeRate }.
      // rpcSessionsList returns this listing verbatim.
      activity: activitySnapshot(session),
    });
  }
  return result;
}

// The qemu backend's throwaway VMs, one per live session (the Settings
// GUI's VM list, routes/vms.js). An exited session's VM is already gone with
// its launcher, so it is not listed. Persistent VMs are listed per VM from
// the pool instead, with their sessions from listPooledQemuSessions.
export function listQemuVms() {
  const result = [];
  for (const [id, session] of sessions) {
    if (session.exited || !session.qemuRunDir) continue;
    result.push({
      sessionId: id,
      cwd: session.cwd,
      app: session.app,
      shell: session.shell,
      customLabel: session.customLabel || null,
      runDir: session.qemuRunDir,
      ...(session.qemuVm || {}),
    });
  }
  return result;
}

// Live sessions attached to a persistent VM: [{ sessionId, vmId, cwd, app,
// shell, customLabel }].
export function listPooledQemuSessions() {
  const result = [];
  for (const [id, session] of sessions) {
    if (session.exited || !session.qemuPoolLease) continue;
    result.push({
      sessionId: id,
      vmId: session.qemuPoolLease.vm.id,
      cwd: session.cwd,
      app: session.app,
      shell: session.shell,
      customLabel: session.customLabel || null,
    });
  }
  return result;
}

// Send one message to the client attached to a session. A socket that has
// gone away (or throws on send) detaches the session instead of breaking the
// pty data path: detachSocket is still the normal path (the ws 'close'
// handler); this is the backstop for a socket that dies without one.
// The chat view's startup list / readiness (see opencodeChat.js).
export function chatStateMsg(session) {
  return { type: 'chat_state', chat: publicChatState(session.chat) };
}

function broadcastChatState(session) {
  broadcast(session, chatStateMsg(session));
}

function broadcast(session, payload) {
  const chan = session?.socket;
  if (!chan) return;
  const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (chan.readyState !== 1) {
    removeViewer(session, chan);
    return;
  }
  try {
    chan.send(str);
  } catch {
    removeViewer(session, chan);
  }
}

// Resize the pty to the attached client's requested size. Invalid values
// leave the pty alone. Returns true when the session exists (whether or not
// the size changed), false when it does not. A socket that is not the
// attached one cannot steer the pty, so a recently-evicted client cannot
// resize the session out from under its replacement.
export function resizeSession(id, socket, cols, rows) {
  const session = sessions.get(id);
  if (!session) return false;
  if (session.socket !== socket) return false;
  const c = Number(cols);
  const r = Number(rows);
  if (!Number.isFinite(c) || !Number.isFinite(r) || c <= 0 || r <= 0) return true;
  const target = { cols: Math.trunc(c), rows: Math.trunc(r) };
  if (target.cols === session.cols && target.rows === session.rows) return true;
  if (!session.exited && session.ptyProcess) {
    try {
      session.ptyProcess.resize(target.cols, target.rows);
    } catch {
      // pty may have died between the exited check and here
      return true;
    }
  }
  session.cols = target.cols;
  session.rows = target.rows;
  return true;
}

// Attaching evicts any incumbent: the new client closes the previous one
// with code 4001 and takes the session over alone. Only one client is ever
// attached, so there is nothing to negotiate -- the pty simply follows the
// attached client's viewport.
export function attachSocket(id, socket, viewport = null) {
  const session = sessions.get(id);
  if (!session) return false;

  if (session.timeoutTimer) {
    clearTimeout(session.timeoutTimer);
    session.timeoutTimer = null;
  }

  const existing = session.socket;
  if (existing && existing !== socket) {
    try { existing.send(JSON.stringify({ type: 'detached', reason: 'replaced' })); } catch { /* already gone */ }
    try { existing.close(4001, 'Replaced by new client'); } catch { /* already gone */ }
  }

  session.socket = socket;
  const c = Number(viewport?.cols);
  const r = Number(viewport?.rows);
  if (Number.isFinite(c) && Number.isFinite(r) && c > 0 && r > 0) {
    const target = { cols: Math.trunc(c), rows: Math.trunc(r) };
    if (target.cols !== session.cols || target.rows !== session.rows) {
      if (!session.exited && session.ptyProcess) {
        try {
          session.ptyProcess.resize(target.cols, target.rows);
        } catch {
          // pty may have died between the exited check and here
          return true;
        }
      }
      session.cols = target.cols;
      session.rows = target.rows;
    }
  }
  return true;
}

// Drop the attached client and arm the destroy timer. No-op if this socket
// is not the attached one, so a duplicate detach cannot arm the timer twice.
function removeViewer(session, socket) {
  if (session.socket !== socket) return;
  session.socket = null;

  const timeout = session.exited
    ? SESSION_EXITED_TIMEOUT_MS
    : SESSION_TIMEOUT_MS;
  if (timeout > 0) {
    console.log(
      `[session] ${session.id} client detached; destroying in ${timeout}ms`
      + `${session.exited ? ' (pty already exited)' : ''}`
    );
  }
  startTimeout(session, timeout);
}

export function detachSocket(id, socketToDetach) {
  const session = sessions.get(id);
  if (!session) return;
  removeViewer(session, socketToDetach);
}

// Best-effort teardown of every sandbox artifact a launch may have built.
// Shared by destroySession() and createSession() spawn-failure cleanup.
function releaseSandboxArtifacts(artifacts) {
  const {
    sandboxStateDir, sandboxGitBrokerProc, sandboxGitBrokerDir, sandboxCommitGuardDir,
    sandboxNetworkBrokerProc, sandboxNetworkBrokerDir, qemuRunDir, qemuPoolLease, chat,
  } = artifacts;
  // opencode chat mode: the password file / relay socket dir.
  if (chat) stopChatMonitor(chat);
  if (chat?.dir) removeChatDir(chat.dir);
  if (sandboxStateDir) { try { rmSync(sandboxStateDir, { recursive: true, force: true }); } catch { /* nothing to remove / still held — harmless */ } }
  if (sandboxGitBrokerProc) { try { sandboxGitBrokerProc.kill('SIGTERM'); } catch { /* already dead */ } }
  if (sandboxGitBrokerDir) { try { rmSync(sandboxGitBrokerDir, { recursive: true, force: true }); } catch { /* best effort */ } }
  if (sandboxCommitGuardDir) { try { rmSync(sandboxCommitGuardDir, { recursive: true, force: true }); } catch { /* best effort */ } }
  // QEMU needs no kill here: it runs in bwrap with --die-with-parent under
  // the launcher (the pty child), so it cannot outlive the session.
  if (qemuRunDir) { try { rmSync(qemuRunDir, { recursive: true, force: true }); } catch { /* best effort */ } }
  // A persistent VM outlives its sessions: only this session's shares are
  // dropped (the pool unmounts what nobody uses and stops an idle VM).
  if (qemuPoolLease) { qemuPoolLease.release().catch(() => {}); }
  if (sandboxNetworkBrokerProc) { try { sandboxNetworkBrokerProc.kill('SIGTERM'); } catch { /* already dead */ } }
  if (sandboxNetworkBrokerDir) { try { rmSync(sandboxNetworkBrokerDir, { recursive: true, force: true }); } catch { /* best effort */ } }
}

// `reason` is for the teardown log only -- it has no effect on behavior. It
// exists because sessions used to vanish with no record of which path took
// them (idle timeout? pty exit cleanup? an explicit teardown? a restart?),
// which made "my session died early" impossible to diagnose after the fact.
export function destroySession(id, { keepSchedule = true, reason = 'request' } = {}) {
  const session = sessions.get(id);
  if (!session) return;

  console.log(
    `[session] ${id} destroyed (reason=${reason}, `
    + `app=${session.app || (session.shell ? 'shell' : 'unknown')}, cwd=${session.cwd}, `
    + `uptime=${Date.now() - session.createdAt}ms, ptyExited=${session.exited}, `
    + `connected=${!!session.socket})`
  );

  if (session.timeoutTimer) {
    clearTimeout(session.timeoutTimer);
    session.timeoutTimer = null;
  }

  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }

  if (session.pendingInjectionTimer) {
    clearTimeout(session.pendingInjectionTimer);
    session.pendingInjectionTimer = null;
  }

  // By default the scheduled prompt outlives the session (disconnect / idle
  // timeout / shutdown) and auto-resumes at fire time. Only an explicit
  // user-initiated teardown cancels it.
  if (keepSchedule) {
    detachScheduleFromSession(id);
  } else {
    cancelScheduledPrompt(id);
  }

  if (!session.exited) {
    try {
      session.ptyProcess.kill();
    } catch {
      // already dead
    }
  }

  // Force-close the pty master read stream. kill() alone only signals the
  // child; if a grandchild still holds the slave fd (or the child lingers),
  // the master never sees EOF and the read stream keeps the event loop
  // alive indefinitely (hanging test runners and lingering handles in prod).
  try {
    session.ptyProcess.destroy();
  } catch {
    // already torn down
  }

  // Remove the sandbox's unique rootlesskit state dir, tear down the
  // host-side git-broker (a plain child process, not part of the
  // --unshare-pid tree the kill above reaps), and remove the commit-message
  // guard's runtime dir (see startCommitGuard, sandbox.js -- just a JSON
  // config file, no process, unlike gitBroker there's nothing to kill).
  releaseSandboxArtifacts(session, session);

  sessions.delete(id);
}

// Retire-first for overlay reuse (#12): destroy the exited predecessor before
// the caller spawns a successor into the same deterministic orchestratorDir.
// destroySession() unlinks the overlay synchronously, so no wait is needed.
export async function retireSessionForReuse(id) {
  const session = sessions.get(id);
  if (!session) return;
  destroySession(id, { keepSchedule: true, reason: 'retire-first' });
}

export function destroyAllSessions() {
  for (const [id] of sessions) {
    destroySession(id, { reason: 'shutdown' });
  }
}

// Kills every live pty, waits up to 3s for them to exit, then tears down all
// local bookkeeping.
export function gracefulShutdown() {
  // The relay isn't tied to any session's ptys, just this process's own
  // listeners.
  gpgVaultRelay.stop();
  return new Promise((resolve) => {
    const pendingSessions = [];

    for (const [, session] of sessions) {
      if (!session.exited) {
        pendingSessions.push(session);
        try {
          session.ptyProcess.kill();
        } catch {
          // already dead
        }
      }
    }

    const finish = () => {
      destroyAllSessions();
      // Persistent VMs belong to no session. QEMU would die with this
      // process anyway (bwrap --die-with-parent); stopping them here also
      // removes their run dirs. Bounded so shutdown never hangs on a VM.
      Promise.race([qemuVmPool.stopAll(), new Promise((r) => setTimeout(r, 5000))]).finally(resolve);
    };

    if (pendingSessions.length === 0) {
      finish();
      return;
    }

    // Wait up to 3 seconds for processes to exit
    let done = false;
    const interval = setInterval(() => {
      if (done) return;
      if (pendingSessions.every((s) => s.exited)) {
        done = true;
        clearInterval(interval);
        finish();
      }
    }, 100);

    setTimeout(() => {
      if (!done) {
        done = true;
        clearInterval(interval);
        finish();
      }
    }, 3000);
  });
}

function appendToBuffer(session, data) {
  session.outputBuffer.push(data);
  session.bufferSize += data.length;

  while (session.bufferSize > OUTPUT_BUFFER_MAX_BYTES && session.outputBuffer.length > 0) {
    const removed = session.outputBuffer.shift();
    session.bufferSize -= removed.length;
  }
}

function startTimeout(session, ms) {
  if (session.timeoutTimer) {
    clearTimeout(session.timeoutTimer);
    session.timeoutTimer = null;
  }

  // Non-positive = the operator disabled idle destruction
  // (CCSERVER_SESSION_TIMEOUT_MS=0); the session then survives until its pty
  // exits or someone tears it down explicitly. The exited-session cleanup
  // never reaches here with a non-positive value (resolveExitedTimeoutMs
  // clamps to >= 1s), so an exited session is always eventually reaped.
  if (!(ms > 0)) return;

  session.timeoutTimer = setTimeout(() => {
    destroySession(session.id, {
      reason: session.exited ? 'exited-timeout' : 'idle-timeout',
    });
  }, ms);
}
