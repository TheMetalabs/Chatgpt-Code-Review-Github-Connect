import { createFileRoute } from "@tanstack/react-router";
import { HistoryBrowser } from "@/components/history-browser";
export const Route = createFileRoute("/history")({ component: History });
function History() { return <div className="mx-auto max-w-6xl px-4 py-8 md:px-8"><h1 className="mb-5 text-3xl font-medium">Review & Job History</h1><HistoryBrowser /></div>; }
