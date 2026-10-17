"use client";

import { useCallback, useId, useState } from "react";
import type { FormEvent } from "react";
import { ApiRequestError } from "@/lib/api";
import { clearDemoCode, getDemoCode, setDemoCode } from "@/lib/demoCode";

/** Small "Enter demo code" field, shown when a protected action returned 401. */
export function DemoCodeForm({ wrong, onSubmit, onCancel }: { wrong: boolean; onSubmit: (code: string) => void; onCancel: () => void }) {
  const id = useId();
  const [code, setCode] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    if (code.trim()) onSubmit(code.trim());
  }

  return (
    <form onSubmit={submit} className="flex w-full flex-wrap items-center gap-2 text-sm">
      <label htmlFor={id} className="font-medium">Enter demo code</label>
      <input
        id={id}
        type="password"
        autoComplete="off"
        autoFocus
        value={code}
        onChange={(e) => setCode(e.target.value)}
        className="min-h-11 w-40 rounded-card border-2 border-rule bg-surface px-3 text-text focus-visible:outline-2 focus-visible:outline-brand"
      />
      <button type="submit" disabled={!code.trim()} className="pc-btn pc-btn--primary">
        Continue
      </button>
      <button type="button" onClick={onCancel} className="pc-btn">
        Cancel
      </button>
      <p role={wrong ? "alert" : "status"} className={`w-full ${wrong ? "text-risk-red" : "text-muted"}`}>
        {wrong ? "That code didn't work. Try again." : "This action needs the demo code. It's remembered on this device."}
      </p>
    </form>
  );
}

/**
 * Runs protected actions. `call(action, retry)` runs `action`; if the server answers 401 it forgets any
 * stored code, shows `form` (render it near the button) and returns false. Once a code is entered it
 * is stored and `retry` runs. Other errors are thrown as usual.
 */
export function useDemoCode() {
  const [prompt, setPrompt] = useState<{ retry: () => void; wrong: boolean } | null>(null);

  const call = useCallback(async (action: () => Promise<unknown>, retry: () => void) => {
    try {
      await action();
      setPrompt(null);
      return true;
    } catch (err) {
      if (!(err instanceof ApiRequestError && err.status === 401)) throw err;
      const wrong = getDemoCode() !== null;
      clearDemoCode();
      setPrompt({ retry, wrong });
      return false;
    }
  }, []);

  const form = prompt && (
    <DemoCodeForm
      wrong={prompt.wrong}
      onSubmit={(code) => {
        setDemoCode(code);
        setPrompt(null);
        prompt.retry();
      }}
      onCancel={() => setPrompt(null)}
    />
  );
  return { call, form };
}
