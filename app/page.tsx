import Link from "next/link";
import ThemeToggle from "@/components/ThemeToggle";

/**
 * The pipeline's four agents, styled as parallel newspaper sections.
 * Deliberately NOT numbered — this is architecture, not a sequence.
 */
const DESKS = [
  {
    section: "Section A",
    role: "The Retriever",
    body: "Sends the query to arXiv, Semantic Scholar, and OpenAlex in parallel and merges their returns. Duplicate papers collapse into a single record; papers independently indexed by more than one database are flagged as corroborated.",
  },
  {
    section: "Section B",
    role: "The Extractor",
    body: "Reads the document and isolates every claim that rests on a citation — keeping the claim, the verbatim quote that anchors it, and the label under which it was cited. Unattributed claims never make the page.",
  },
  {
    section: "Section C",
    role: "The Falsifier",
    body: "Tries to BREAK each claim rather than confirm it. A claim only survives if the Falsifier fails AND its quoted evidence appears verbatim in the source — a deterministic grounding check runs after the model, so an ungrounded quote downgrades the claim no matter what the reasoning says.",
    stamps: true,
  },
  {
    section: "Section D",
    role: "The Synthesizer (Arbiter)",
    body: "Hard-gated by the Claim Graph: it may only reason from claims that survived adversarial falsification and the grounding check. Every other claim is filed under Gaps and is excluded from the conclusions — the consensus never promotes them.",
  },
];

function VerdictStamps() {
  return (
    /* In flow at the end of the dispatch — collision-free at every width. */
    <div aria-hidden="true" className="mt-5 flex justify-end gap-3">
      <span className="stamp stamp--green rotate-2">Survived</span>
      <span className="stamp stamp--red -rotate-2">Falsified</span>
    </div>
  );
}

export default function Home() {
  return (
    <div className="flex min-h-full flex-col bg-paper font-sans text-ink">
      <main className="mx-auto w-full max-w-6xl flex-1 px-5 sm:px-10">
        {/* ── Masthead ─────────────────────────────────────────────── */}
        <header>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-y border-hairline py-1.5 font-mono text-[0.625rem] uppercase tracking-[0.25em] text-muted-ink sm:text-[0.6875rem]">
            <span>Vol. 1 · No. 1</span>
            <span className="hidden sm:inline">Est. 2026</span>
            <span className="flex items-center gap-3">
              <span>August 10, 2026</span>
              <ThemeToggle />
            </span>
          </div>

          <h1 className="mt-6 text-center font-display text-[clamp(2.75rem,9vw,6rem)] font-black leading-none tracking-[-0.02em] sm:mt-8">
            PaperAgents
          </h1>

          <div className="mt-5 h-px w-full bg-ink" />

          <p className="mt-3 text-center font-mono text-[0.625rem] uppercase tracking-[0.3em] text-muted-ink sm:text-xs">
            Citation Verification · Multi-Agent System
          </p>

          <div className="mt-4 h-px w-full bg-hairline" />
        </header>

        {/* ── Hero — the front page ────────────────────────────────── */}
        <section
          aria-labelledby="lead-headline"
          className="pb-16 pt-12 text-center sm:pb-24 sm:pt-16"
        >
          <p className="rise font-mono text-[0.625rem] uppercase tracking-[0.3em] text-muted-ink sm:text-[0.6875rem]">
            A Special Report from the Citation Desk
          </p>

          <h2
            id="lead-headline"
            className="rise rise-1 mx-auto mt-6 max-w-4xl font-display text-[clamp(2.1rem,5.5vw,4.25rem)] font-bold leading-[1.05] tracking-[-0.015em] text-balance"
          >
            The paper cited it.{" "}
            <em className="italic">The sources don&rsquo;t back it up.</em>
          </h2>

          <div className="rise rise-2 mx-auto mt-8 flex max-w-2xl items-center gap-4">
            <span className="hidden h-px flex-1 bg-hairline sm:block" />
            <p className="font-mono text-[0.625rem] uppercase tracking-[0.25em] text-muted-ink sm:text-[0.6875rem]">
              By the PaperAgents Desk · File No. 001
            </p>
            <span className="hidden h-px flex-1 bg-hairline sm:block" />
          </div>

          <p className="rise rise-2 mx-auto mt-6 max-w-2xl text-[0.975rem] leading-7 text-ink/90 sm:text-lg sm:leading-8">
            PaperAgents puts every citation in your paper on the record: four
            agents — Retriever, Extractor, Falsifier, Synthesizer — gather the
            sources, isolate the claims, try to break each one against the
            source text, and file a verdict with the gaps spelled out.
          </p>

          <div className="rise rise-3 mt-10 flex flex-col items-center gap-4">
            <Link
              href="/analyze"
              className="group inline-flex min-h-11 w-full items-center justify-center gap-3 rounded-[5px] border-2 border-ink bg-paper px-8 py-4 font-mono text-xs font-semibold uppercase tracking-[0.22em] text-ink transition-colors duration-200 hover:bg-ink hover:text-paper active:translate-y-px motion-reduce:transition-none sm:w-auto sm:text-sm"
            >
              Analyze a Paper
              <span
                aria-hidden="true"
                className="transition-transform duration-200 group-hover:translate-x-1 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
              >
                →
              </span>
            </Link>
            <p className="font-mono text-[0.625rem] uppercase tracking-[0.25em] text-muted-ink">
              No sign-in · No fee · Verdicts in minutes
            </p>
          </div>
        </section>

        {/* ── Pipeline sections ────────────────────────────────────── */}
        <section aria-labelledby="desks-heading" className="pb-16 sm:pb-24">
          <div className="flex items-center gap-4">
            <span className="h-px flex-1 bg-hairline" />
            <h2
              id="desks-heading"
              className="text-center font-mono text-[0.6875rem] uppercase tracking-[0.3em] text-muted-ink"
            >
              The Claim Graph · Four Agents, One Verdict
            </h2>
            <span className="h-px flex-1 bg-hairline" />
          </div>

          <div className="mt-7 grid grid-cols-1 divide-y divide-hairline border-y border-hairline sm:grid-cols-2 sm:divide-y-0 sm:divide-x xl:grid-cols-4">
            {DESKS.map(({ section, role, body, stamps }) => (
              <article key={section} className="relative px-6 py-8 sm:px-7">
                <p className="font-mono text-[0.625rem] uppercase tracking-[0.3em] text-muted-ink">
                  {section}
                </p>
                <h3 className="mt-3 font-sans text-2xl font-bold leading-tight tracking-tight">
                  {role}
                </h3>
                <p className="mt-3 text-[0.9375rem] leading-6 text-ink/85 [text-wrap:pretty]">
                  {body}
                </p>
                {stamps ? <VerdictStamps /> : null}
              </article>
            ))}
          </div>
        </section>
      </main>

      {/* ── Wire-service credit ───────────────────────────────────── */}
      <footer className="border-t border-hairline">
        <div className="mx-auto w-full max-w-6xl px-5 py-8 text-center sm:px-10">
          <p className="font-mono text-[0.625rem] uppercase tracking-[0.16em] text-muted-ink sm:text-[0.6875rem] sm:tracking-[0.25em]">
            Powered by free-tier OpenRouter models · Cross-verified via arXiv,
            Semantic Scholar &amp; OpenAlex
          </p>
          <p className="mt-3 font-mono text-[0.5625rem] uppercase tracking-[0.16em] text-muted-ink sm:tracking-[0.25em]">
            © 2026 PaperAgents · Set in Fraunces, Inter &amp; IBM Plex Mono
          </p>
        </div>
      </footer>
    </div>
  );
}
