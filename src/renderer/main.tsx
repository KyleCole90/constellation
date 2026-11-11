import { RouterProvider } from "@tanstack/react-router";
import React from "react";
import ReactDOM from "react-dom/client";

import "./index.css";

import { keepFocusOnThePage } from "./lib/lostFocus";
import { router } from "./router";
import { faultLab, workspaceStore } from "./stores/workspace";

const start = async () => {
  if (import.meta.env.DEV) {
    const lab = faultLab();
    Object.assign(window, { __faultLab: lab });
    const noise = sessionStorage.getItem("verify.noise");
    if (noise) {
      // oxlint-disable-next-line typescript/no-unsafe-argument -- TS review debt: parse verify.noise into a Noise patch
      lab.setNoise(JSON.parse(noise));
      lab.setDemoScript(false);
    }
  }
  void workspaceStore().getState().boot();
  keepFocusOnThePage(document);

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <RouterProvider router={router} />
    </React.StrictMode>,
  );
};
void start();
