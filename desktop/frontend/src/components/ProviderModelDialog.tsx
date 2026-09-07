import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LockKeyhole, RotateCcw } from "lucide-react";
import { useT } from "../lib/i18n";
import { imageInputHardBlocked, imageInputState } from "../lib/providerImageInput";
import { ModalCloseButton } from "./ModalCloseButton";
import type { ProviderModelCapabilityView } from "../lib/types";

export interface ModelDetailsDraft { model: string; contextWindow: string; maxOutputTokens: number; vision: boolean | null; }
export default function ProviderModelDialog({ initial, candidates, contextDefault, capability, baseURL, busy, onClose, onApply }: {
  initial?: ModelDetailsDraft; candidates: string[]; contextDefault?: number;
  capability?: ProviderModelCapabilityView; baseURL?: string; busy: boolean; onClose: () => void; onApply: (draft: ModelDetailsDraft) => void;
}) {
  const t = useT(), titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [model, setModel] = useState(initial?.model ?? "");
  const [context, setContext] = useState(initial?.contextWindow ?? "");
  const [output, setOutput] = useState(initial?.maxOutputTokens ? String(Math.max(-1, initial.maxOutputTokens)) : "");
  const [vision, setVision] = useState(initial?.vision == null ? "auto" : String(initial.vision));
  const [error, setError] = useState(false);
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    dialog.current?.querySelector<HTMLInputElement>("input:not(:disabled)")?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  const validNumber = (value: string, omit = false) => !value.trim() || (Number.isSafeInteger(Number(value)) && (Number(value) > 0 || (omit && Number(value) === -1)));
  const valid = Boolean(model.trim()) && !/[\s,，]/.test(model.trim()) && (Boolean(initial) || !candidates.some(id => id.toLowerCase() === model.trim().toLowerCase())) && validNumber(context) && validNumber(output, true);
  const imageBlocked = imageInputHardBlocked(baseURL, model, capability);
  const imageState = imageBlocked ? "unsupported" : imageInputState(vision === "auto" ? "auto" : vision === "true" ? "on" : "off", capability);
  return createPortal(<dialog ref={dialog} className="provider-model-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); if (!valid) { setError(true); return; } onApply({ model:model.trim(), contextWindow:context.trim(), maxOutputTokens:Number(output) || 0, vision:vision === "auto" ? null : !imageBlocked && vision === "true" }); }}>
      <header><h2 id={titleId}>{t(initial ? "settings.modelDialog.edit" : "settings.models.add")}</h2><ModalCloseButton label={t("common.close")} disabled={busy} onClick={onClose}/></header>
      <label className="provider-model-dialog__id">{t("settings.modelDialog.id")}
        {initial ? <span><LockKeyhole size={16}/>{model}</span> : <input autoFocus className="mem-input" value={model} disabled={busy} onChange={e=>setModel(e.target.value)} placeholder="deepseek-v4-flash"/>}
      </label>
      <div className="provider-model-dialog__columns">
        <section><h3>{t("settings.modelDialog.parameters")}</h3>
          <label htmlFor={`${titleId}-context`}>{t("settings.modelContextWindow")}<button type="button" className="btn provider-icon-action" title={t("settings.modelDialog.reset")} aria-label={t("settings.modelDialog.resetContext")} disabled={busy} onClick={()=>setContext("")}><RotateCcw size={16}/></button>
            <input id={`${titleId}-context`} className="mem-input" type="number" min={1} value={context} disabled={busy} placeholder={t("settings.models.inherit")} onChange={e=>setContext(e.target.value)}/>
          </label>
          <p>{t("settings.models.inherit")}{contextDefault ? ` · ${contextDefault.toLocaleString()}` : ""}</p>
          <label htmlFor={`${titleId}-output`}>{t("settings.modelDialog.outputLimit")}<button type="button" className="btn provider-icon-action" title={t("settings.modelDialog.reset")} aria-label={t("settings.modelDialog.resetOutput")} disabled={busy} onClick={()=>setOutput("")}><RotateCcw size={16}/></button>
            <input id={`${titleId}-output`} className="mem-input" type="number" min={-1} value={output} disabled={busy} placeholder={t("settings.models.inherit")} onChange={e=>setOutput(e.target.value)}/>
          </label>
          <p>{t("settings.modelDialog.outputHint")}</p>
        </section>
        <aside><h3>{t("settings.modelDialog.capabilities")}</h3>
          <div className="provider-model-dialog__capability-title">{t("settings.modelDialog.input")}</div>
          <div className="provider-model-dialog__chips">
            <label><input type="checkbox" checked disabled/>{t("settings.textInput")}<LockKeyhole size={14}/></label>
            <label><input type="checkbox" checked={imageState === "supported"} disabled={busy || imageBlocked} onChange={event=>setVision(String(event.target.checked))}/>{t("settings.modelDialog.image")}</label>
            <label title={t("settings.modelDialog.unavailable")}><input type="checkbox" checked={false} disabled/>{t("settings.modelDialog.video")}</label>
            <label title={t("settings.modelDialog.unavailable")}><input type="checkbox" checked={false} disabled/>PDF</label>
          </div>
          <p>{t("settings.modelDialog.unavailable")}</p>
          <div className="provider-model-dialog__capability-title">{t("settings.modelDialog.output")}</div>
          <div className="provider-model-dialog__chips"><label><input type="checkbox" checked disabled/>{t("settings.textInput")}<LockKeyhole size={14}/></label></div>
          <dl><div><dt>{t("settings.modelDialog.source")}</dt><dd>{vision !== "auto" ? t("settings.modelDialog.manual") : capability ? t("settings.modelDialog.metadata") : t("settings.imageInputUnknown")}</dd></div></dl>
          <button type="button" className="btn" disabled={busy || vision === "auto"} onClick={()=>setVision("auto")}>{t("settings.modelDialog.restore")}</button>
          <p>{t("settings.modelDialog.overrideHint")}</p>
        </aside>
      </div>
      {error && <p role="alert">{t("settings.modelDialog.invalid")}</p>}
      <footer><small>{t("settings.modelDialog.draftHint")}</small><button type="button" className="btn" disabled={busy} onClick={onClose}>{t("common.cancel")}</button><button className="btn btn--primary" disabled={busy}>{t(initial ? "settings.modelDialog.apply" : "settings.modelDialog.add")}</button></footer>
    </form>
  </dialog>, document.body);
}
