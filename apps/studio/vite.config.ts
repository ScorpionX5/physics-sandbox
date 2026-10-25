import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Die Simulation laeuft im Browser, nicht auf dem Server: `@sandbox/core` ist
 * reines TypeScript ohne Grafik-Abhaengigkeit und wird mitgebundelt. Ein Klick
 * auf Play braucht deshalb keinen Netzaufruf.
 *
 * Der Dienst wird nur fuer den Bibliothekar gebraucht - also fuer den einen
 * Fall, in dem ein API-Schluessel im Spiel ist, der nichts im Browser zu suchen
 * hat. Darum der Proxy statt eines direkten Aufrufs.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/v1": {
        target: process.env["SANDBOX_SERVICE"] ?? "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
});
