import { RouterProvider } from "@tanstack/react-router";
import React from "react";
import ReactDOM from "react-dom/client";
import * as v from "valibot";

import "./index.css";

import { reportError } from "./desktop";
import { keepFocusOnThePage } from "./lib/lostFocus";
import { router } from "./router";
import { NoisePatchSchema, faultLab, setAgentStandIn, workspaceStore } from "./stores/workspace";

const start = async () => {
  window.addEventListener("error", (event) => reportError(event.error));
  window.addEventListener("unhandledrejection", (event) => reportError(event.reason));
  if (import.meta.env.DEV) {
    const lab = faultLab();
    Object.assign(window, {
      __setAgentStandIn: setAgentStandIn,
      ...(lab ? { __faultLab: lab } : {}),
    });
    const noise = sessionStorage.getItem("verify.noise");
    if (lab && noise) {
      const patch = v.safeParse(NoisePatchSchema, JSON.parse(noise));
      if (patch.success) lab.setNoise(patch.output);
      lab.setDemoScript(false);
    }
  }
  void workspaceStore().getState().boot();
  router.subscribe("onResolved", ({ toLocation }) => {
    if (/^\/(due|courses)\b/.test(toLocation.pathname)) workspaceStore().getState().freshen();
  });
  keepFocusOnThePage(document);

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <RouterProvider router={router} />
    </React.StrictMode>,
  );
};
void start();
