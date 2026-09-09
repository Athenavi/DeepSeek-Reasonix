import type { ActResult } from "./actions.js";
import type { GuestDebugger, GuestPage } from "./guestView.js";
import type { LocatedRef } from "./refResolver.js";
import { REGISTRY_KEY } from "./snapshot.js";

const OBJECT_GROUP = "reasonix-upload";

interface ExecutionContext {
  id: number;
  auxData?: { isDefault?: boolean; frameId?: string };
}

function objectIdOf(result: unknown): string | null {
  const objectId = (result as { result?: { objectId?: unknown } } | null)?.result?.objectId;
  return typeof objectId === "string" ? objectId : null;
}

// Runtime.enable replays executionContextCreated for every live context
// before its own reply, so a listener registered around it sees them all.
async function executionContexts(dbg: GuestDebugger): Promise<ExecutionContext[]> {
  const contexts: ExecutionContext[] = [];
  const listener = (_event: unknown, method: string, params: unknown) => {
    if (method !== "Runtime.executionContextCreated") return;
    const context = (params as { context?: ExecutionContext } | null)?.context;
    if (context && typeof context.id === "number") contexts.push(context);
  };
  dbg.on("message", listener);
  try {
    await dbg.sendCommand("Runtime.enable");
  } finally {
    dbg.removeListener("message", listener);
  }
  return contexts;
}

// Find the original registry node in its execution context, including the
// main frame's isolated world. A CSS path would silently select a replacement
// input after a rerender or a navigation.
async function findObjectId(dbg: GuestDebugger, located: LocatedRef): Promise<string | null> {
  const lookup = `(() => { const r = window[${JSON.stringify(REGISTRY_KEY)}]; if (!r || r.docId !== ${JSON.stringify(located.binding.docId)} || r.snapshotId !== ${JSON.stringify(located.snapshotId)}) return null; const e = r.refs.get(${JSON.stringify(located.ref)}); return e && e.isConnected && e.tagName === 'INPUT' && e.type === 'file' ? e : null; })()`;
  try {
    for (const context of await executionContexts(dbg)) {
      if (located.isMainFrame && context.auxData?.isDefault) continue;
      try {
        const objectId = objectIdOf(await dbg.sendCommand("Runtime.evaluate", { expression: lookup, contextId: context.id, objectGroup: OBJECT_GROUP }));
        if (objectId) return objectId;
      } catch {
        // A context that vanished mid-walk is simply not the one we want.
      }
    }
  } finally {
    await dbg.sendCommand("Runtime.disable").catch(() => undefined);
  }
  return null;
}

export async function uploadFiles(page: GuestPage, located: LocatedRef, files: string[], verify: () => void, dispatch: () => void): Promise<ActResult> {
  if (located.tag !== "input" || located.type !== "file") return { executed: false, reason: "element is not a file input" };
  const dbg = page.debugger;
  const attached = dbg.isAttached();
  if (!attached) dbg.attach("1.3");
  try {
    const objectId = await findObjectId(dbg, located);
    if (!objectId) return { executed: false, reason: "file input could not be located in the page" };
    verify();
    dispatch();
    await dbg.sendCommand("DOM.setFileInputFiles", { objectId, files });
    await dbg.sendCommand("Runtime.releaseObjectGroup", { objectGroup: OBJECT_GROUP }).catch(() => undefined);
    return { executed: true };
  } finally {
    if (!attached && dbg.isAttached()) dbg.detach();
  }
}
