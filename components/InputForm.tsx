"use client";

import { useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";

interface InputFormProps {
  running: boolean;
  onAnalyze: (input: string, file: File | null) => void;
}

const MAX_PDF_BYTES = 15 * 1024 * 1024; // must match the API route's limit

export default function InputForm({ running, onAnalyze }: InputFormProps) {
  const [input, setInput] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // A run needs at least one source of truth: free text OR an uploaded
  // document. The backend mirrors this (it accepts PDF-only submissions).
  const canSubmit = (input.trim().length > 0 || file !== null) && !running;

  function acceptFile(candidate: File | undefined | null) {
    if (!candidate) return;
    if (candidate.type !== "application/pdf") {
      setFileError("Only PDF files are accepted at this desk.");
      return;
    }
    if (candidate.size > MAX_PDF_BYTES) {
      setFileError("That file is over the 15 MB limit.");
      return;
    }
    setFileError(null);
    setFile(candidate);
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit) return;
    onAnalyze(input.trim(), file);
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    acceptFile(e.target.files?.[0]);
    e.target.value = ""; // allow re-selecting the same file
  }

  function handleDropKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInputRef.current?.click();
    }
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-6 lg:grid-cols-2">
      {/* ── Text input ─────────────────────────────────────────────────── */}
      <div className="flex flex-col">
        <label
          htmlFor="claim-input"
          className="font-mono text-[0.625rem] uppercase tracking-[0.3em] text-muted-ink"
        >
          The claim · arXiv link · topic
        </label>
        <textarea
          id="claim-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={6}
          placeholder="e.g. “Attention is All You Need introduced the transformer architecture, which relies entirely on self-attention without recurrence or convolution.”"
          className="mt-3 w-full flex-1 resize-y border-2 border-ink bg-paper px-4 py-3 text-sm leading-6 text-ink placeholder:text-ink/35 focus:border-ink focus:outline-none focus:ring-2 focus:ring-ink"
        />
        <p className="mt-2 font-mono text-[0.5625rem] uppercase tracking-[0.2em] text-muted-ink">
          A claim to check, paper title, or arXiv link — optional if you&rsquo;re
          uploading a PDF
        </p>
      </div>

      {/* ── PDF dropzone ───────────────────────────────────────────────── */}
      <div className="flex flex-col">
        <span className="font-mono text-[0.625rem] uppercase tracking-[0.3em] text-muted-ink">
          The document (optional)
        </span>

        <div
          role="button"
          tabIndex={0}
          aria-label="Upload a PDF of the paper"
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={handleDropKeyDown}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            acceptFile(e.dataTransfer.files?.[0]);
          }}
          className={`mt-3 flex flex-1 cursor-pointer flex-col items-center justify-center gap-2 border-2 border-dashed px-4 py-8 text-center transition-colors duration-200 ${
            dragging
              ? "border-ink bg-ink/5"
              : "border-hairline hover:border-ink/60 hover:bg-ink/[0.03]"
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            className="sr-only"
            onChange={handleFileChange}
          />

          {file ? (
            <>
              <p className="max-w-full truncate px-2 font-mono text-xs font-semibold uppercase tracking-[0.18em] text-ink">
                {file.name}
              </p>
              <p className="font-mono text-[0.5625rem] uppercase tracking-[0.2em] text-muted-ink">
                {(file.size / 1024 / 1024).toFixed(2)} MB · filed
              </p>
            </>
          ) : (
            <>
              <p className="font-mono text-xs font-semibold uppercase tracking-[0.22em] text-ink">
                Drop a PDF here
              </p>
              <p className="font-mono text-[0.5625rem] uppercase tracking-[0.2em] text-muted-ink">
                — or tap to browse — under 15 MB
              </p>
            </>
          )}
        </div>

        {fileError ? (
          <p className="mt-2 font-mono text-[0.625rem] uppercase tracking-[0.18em] text-accent-red">
            {fileError}
          </p>
        ) : file ? (
          /* Remove lives OUTSIDE the clickable dropzone — no nested interactives. */
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            <p className="font-mono text-[0.5625rem] uppercase tracking-[0.2em] text-accent-green">
              Filed · ready to submit
            </p>
            <button
              type="button"
              onClick={() => {
                setFile(null);
                setFileError(null);
              }}
              className="min-h-11 border border-hairline px-3 font-mono text-[0.5625rem] uppercase tracking-[0.2em] text-muted-ink transition-colors hover:border-ink hover:text-ink"
            >
              Remove file
            </button>
          </div>
        ) : (
          <p className="mt-2 font-mono text-[0.5625rem] uppercase tracking-[0.2em] text-muted-ink">
            Skipped when absent — claims are pulled from retrieved abstracts
          </p>
        )}
      </div>

      {/* ── Submit row ─────────────────────────────────────────────────── */}
      <div className="flex flex-col items-start gap-3 lg:col-span-2">
        <button
          type="submit"
          disabled={!canSubmit}
          className="group inline-flex min-h-11 w-full items-center justify-center gap-3 rounded-[5px] border-2 border-ink bg-paper px-8 py-4 font-mono text-xs font-semibold uppercase tracking-[0.22em] text-ink transition-colors duration-200 hover:bg-ink hover:text-paper active:translate-y-px disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-paper disabled:hover:text-ink motion-reduce:transition-none sm:w-auto"
        >
          {running ? (
            <>
              <span aria-hidden="true" className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-ink motion-reduce:animate-none">
                &nbsp;
              </span>
              Analysis in progress
            </>
          ) : (
            <>
              Analyze
              <span
                aria-hidden="true"
                className="transition-transform duration-200 group-hover:translate-x-1 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
              >
                →
              </span>
            </>
          )}
        </button>

        {!input.trim() && !file && !running ? (
          <p className="font-mono text-[0.5625rem] uppercase tracking-[0.2em] text-muted-ink">
            Add a claim or upload a PDF to enable the button
          </p>
        ) : null}
      </div>
    </form>
  );
}
