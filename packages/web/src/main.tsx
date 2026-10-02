import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ReactFlowProvider } from "@xyflow/react";
import { App } from "./app";
import { MantineProvider } from "@mantine/core";
import { workbenchTheme } from "./theme";
import "@mantine/core/styles.css";
import "@xyflow/react/dist/style.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MantineProvider theme={workbenchTheme} defaultColorScheme="dark">
      <ReactFlowProvider>
        <App />
      </ReactFlowProvider>
    </MantineProvider>
  </StrictMode>,
);
