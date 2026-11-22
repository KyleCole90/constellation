import { RouterProvider } from "@tanstack/react-router";
import React from "react";
import ReactDOM from "react-dom/client";
import * as v from "valibot";

import "./index.css";

import { DesktopBridgeProvider, desktopBridge, reportError } from "./desktop";
import { keepFocusOnThePage } from "./lib/lostFocus";
import { router } from "./router";
import {
  NoisePatchSchema,
  WorkspaceProvider,
  faultLab,
  setAgentStandIn,
  workspaceStore,
} from "./stores/workspace";

const start = async () => {
  window.addEventListener("error", (event) => reportError(event.error));
  window.addEventListener("unhandledrejection", (event) => reportError(event.reason));
  if (import.meta.env.DEV) {
    const lab = faultLab();
    Object.assign(window, {
      __setAgentStandIn: setAgentStandIn,
      ...(lab
        ? {
            __faultLab: Object.assign(lab, {
              expireFocusThrottle: () => workspaceStore().expireFocusThrottle(),
            }),
          }
        : {}),
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

  const root = document.getElementById("root");
  if (!root) throw new Error("index.html has no #root to render into.");
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <DesktopBridgeProvider value={desktopBridge}>
        <WorkspaceProvider value={workspaceStore()}>
          <RouterProvider router={router} />
        </WorkspaceProvider>
      </DesktopBridgeProvider>
    </React.StrictMode>,
  );
};
void start();
