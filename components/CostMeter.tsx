import { formatCost } from "@/lib/pipeline-reducer";

interface CostMeterProps {
  benchmarkCost: number;
  customerCharge: number;
}

export default function CostMeter({
  benchmarkCost,
  customerCharge,
}: CostMeterProps) {
  const saved = benchmarkCost - customerCharge;

  return (
    <div className="flex w-full flex-wrap items-center gap-x-5 gap-y-3 border-2 border-ink bg-paper px-4 py-3 sm:w-auto sm:items-center sm:gap-y-2 sm:py-2.5">
      <div>
        <p className="font-mono text-[0.5625rem] uppercase tracking-[0.22em] text-muted-ink">
          You pay
        </p>
        <p className="font-mono text-lg font-semibold tabular-nums leading-6 text-ink">
          {formatCost(customerCharge)}
        </p>
      </div>
      <div className="hidden h-8 w-px bg-hairline sm:block" />
      <div>
        <p className="font-mono text-[0.5625rem] uppercase tracking-[0.22em] text-muted-ink">
          Benchmark
        </p>
        <p className="font-mono text-sm tabular-nums leading-6 text-muted-ink">
          {formatCost(benchmarkCost)}
        </p>
      </div>
      <div className="hidden h-8 w-px bg-hairline sm:block" />
      <div>
        <p className="font-mono text-[0.5625rem] uppercase tracking-[0.22em] text-muted-ink">
          Saved
        </p>
        <p className="font-mono text-sm tabular-nums leading-6 text-accent-green">
          {formatCost(saved)}
        </p>
      </div>
    </div>
  );
}
