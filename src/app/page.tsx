import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowRight, Sparkles } from "lucide-react";

const features = [
  "Tailwind v4 styling",
  "Reusable UI primitives",
  "Vitest + Testing Library",
];

export default function Home() {
  return (
    <main className="relative min-h-screen overflow-hidden px-6 py-10 text-slate-950">
      <div className="absolute inset-0 -z-10 opacity-80 [background:radial-gradient(circle_at_top_left,rgba(15,118,110,0.18),transparent_32%),radial-gradient(circle_at_80%_10%,rgba(15,23,42,0.08),transparent_24%),linear-gradient(180deg,rgba(255,250,243,1)_0%,rgba(245,239,229,1)_100%)]" />

      <div className="mx-auto flex min-h-[calc(100vh-5rem)] w-full max-w-6xl items-center">
        <Card className="grid gap-10 p-8 md:grid-cols-[1.15fr_0.85fr] md:p-12">
          <section className="flex flex-col justify-between gap-8">
            <div className="space-y-6">
              <Badge>
                <Sparkles className="mr-2 h-3.5 w-3.5" />
                Initialized stack
              </Badge>

              <div className="space-y-4">
                <h1 className="max-w-xl text-5xl font-semibold tracking-[-0.06em] text-slate-950 md:text-7xl">
                  A Next.js base that is ready for real work.
                </h1>
                <p className="max-w-xl text-base leading-8 text-slate-600 md:text-lg">
                  Tailwind is wired in, component primitives are in place, and
                  the project has a formatter plus test runner from day one.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <Button>
                Get started
                <ArrowRight className="h-4 w-4" />
              </Button>
              <Button variant="secondary">View components</Button>
            </div>
          </section>

          <aside className="rounded-[24px] border border-slate-200 bg-slate-950 p-6 text-white shadow-2xl shadow-slate-950/15">
            <p className="text-sm font-medium tracking-[0.2em] text-slate-400 uppercase">
              Included
            </p>

            <ul className="mt-6 space-y-4">
              {features.map((feature) => (
                <li
                  key={feature}
                  className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3"
                >
                  <span>{feature}</span>
                  <span className="text-sm text-emerald-300">Ready</span>
                </li>
              ))}
            </ul>
          </aside>
        </Card>
      </div>
    </main>
  );
}
