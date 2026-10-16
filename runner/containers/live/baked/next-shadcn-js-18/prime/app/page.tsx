"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useState } from "react";
import DataGrid from "@/components/DataGrid";

function buildSearchString(
  current: URLSearchParams,
  updates: Record<string, string>
) {
  const next = new URLSearchParams(current);
  for (const [key, value] of Object.entries(updates)) {
    if (value === "" || value === "all") {
      next.delete(key);
    } else {
      next.set(key, value);
    }
  }
  const qs = next.toString();
  return qs ? `?${qs}` : "";
}

function HomeContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [q, setQ] = useState(searchParams.get("q") ?? "");
  const [country, setCountry] = useState(searchParams.get("country") ?? "");
  const [status, setStatus] = useState(searchParams.get("status") ?? "");

  const setParams = useCallback(() => {
    const next = buildSearchString(searchParams, { q, country, status });
    router.replace(next ? `${pathname}${next}` : pathname);
  }, [router, pathname, searchParams, q, country, status]);

  return (
    <div className="relative flex flex-col gap-4 p-4 z-1">
      <div className="flex flex-wrap items-center gap-3 w-full max-w-[720px] mx-auto">
        <div className="flex-1 min-w-[200px] max-w-sm">
          <Input
            placeholder="Search..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <Select
          value={country}
          onValueChange={setCountry}
        >
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Filter by country" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All countries</SelectItem>
            <SelectItem value="canada">Canada</SelectItem>
            <SelectItem value="uk">UK</SelectItem>
            <SelectItem value="germany">Germany</SelectItem>
            <SelectItem value="france">France</SelectItem>
            <SelectItem value="netherlands">Netherlands</SelectItem>
            <SelectItem value="switzerland">Switzerland</SelectItem>
            <SelectItem value="mexico">Mexico</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={status}
          onValueChange={setStatus}
        >
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex gap-2">
          <Button onClick={setParams}>
            Apply
          </Button>
        </div>
      </div>
      <div className="w-full max-w-[720px] mx-auto">
        <DataGrid />
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<div className="flex flex-col gap-4 p-4 min-h-[200px]" />}>
      <HomeContent />
    </Suspense>
  );
}
