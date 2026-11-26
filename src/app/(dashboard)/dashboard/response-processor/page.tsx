"use client";

import { useTranslations } from "next-intl";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import ResponseProcessorPanel from "./ResponseProcessorPanel";

export default function ResponseProcessorPage() {
  const tSidebar = useTranslations("sidebar");
  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHeader compact title={tSidebar("responseProcessor")} />
      <ResponseProcessorPanel />
    </div>
  );
}
