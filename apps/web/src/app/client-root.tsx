"use client";
import dynamic from "next/dynamic";

// The ported UI touches window, document and localStorage, so it only ever renders in the browser.
const Root = dynamic(() => import("../rendrr/app.js").then((m) => m.Root), { ssr: false, loading: () => null });

export default function ClientRoot() {
  return <Root />;
}
