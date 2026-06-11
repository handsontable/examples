import { Suspense } from "react";
import HomePage from "@/components/HomePage";

export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <Suspense fallback={<div className="flex flex-col gap-4 p-4 min-h-[200px]" />}>
      <HomePage />
    </Suspense>
  );
}
