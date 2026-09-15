import { createFileRoute } from "@tanstack/react-router";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { zipStore } from "@/lib/zip-store";

export const Route = createFileRoute("/api/bridge-pack")({
  server: {
    handlers: {
      GET: async () => {
        const dir = join(process.cwd(), "extension");
        const files = readdirSync(dir)
          .filter((name) => !name.startsWith("."))
          .map((name) => ({
            name,
            data: new Uint8Array(readFileSync(join(dir, name))),
          }));
        const zip = zipStore(files);
        return new Response(Buffer.from(zip), {
          headers: {
            "Content-Type": "application/zip",
            "Content-Disposition": "attachment; filename=ashlar-bridge.zip",
            "Cache-Control": "no-store",
          },
        });
      },
    },
  },
});
