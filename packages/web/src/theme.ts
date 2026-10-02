import {
  Button,
  Code,
  createTheme,
  Fieldset,
  Input,
  Paper,
  Table,
  Tabs,
  Text,
} from "@mantine/core";

/** Shared library tokens for every Kouro screen, including the visualization hosts. */
export const workbenchTheme = createTheme({
  primaryColor: "indigo",
  primaryShade: { light: 6, dark: 4 },
  colors: {
    dark: [
      "#edf0ef",
      "#c4cac8",
      "#a4adab",
      "#7e8986",
      "#30383a",
      "#252d2f",
      "#151a1c",
      "#0f1517",
      "#0c1113",
      "#080d0f",
    ],
    indigo: [
      "#eff1ff",
      "#e0e4ff",
      "#c4cbff",
      "#a6b1ff",
      "#8999ff",
      "#7183f4",
      "#596cdb",
      "#4657be",
      "#39479e",
      "#303c83",
    ],
  },
  fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
  fontFamilyMonospace: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSizes: { xs: "0.75rem", sm: "0.875rem", md: "0.9375rem", lg: "1.0625rem", xl: "1.25rem" },
  defaultRadius: 2,
  respectReducedMotion: true,
  headings: {
    sizes: { h1: { fontSize: "1.75rem" }, h2: { fontSize: "1.25rem" }, h3: { fontSize: "1rem" } },
  },
  components: {
    Button: Button.extend({
      defaultProps: { size: "sm", variant: "default", radius: 2, fw: 400 },
      styles: { label: { whiteSpace: "normal", overflowWrap: "anywhere" } },
    }),
    Paper: Paper.extend({ defaultProps: { withBorder: true, p: "md", radius: 2 } }),
    Fieldset: Fieldset.extend({ defaultProps: { p: "md", radius: 2 } }),
    Input: Input.extend({ defaultProps: { size: "sm" } }),
    Text: Text.extend({ styles: { root: { overflowWrap: "anywhere" } } }),
    Code: Code.extend({
      styles: { root: { maxWidth: "100%", whiteSpace: "pre-wrap", overflowWrap: "anywhere" } },
    }),
    Tabs: Tabs.extend({ styles: { tab: { minHeight: 40 } } }),
    Table: Table.extend({
      defaultProps: { highlightOnHover: true, verticalSpacing: "sm", horizontalSpacing: "md" },
    }),
  },
  other: {
    sidebarWidth: 248,
    inspectorWidth: 380,
    graphHeight: 460,
    timelineHeight: 250,
    sessionHeight: "min(55dvh, 680px)",
  },
});

export function stateColor(state?: string): string {
  if (["succeeded", "passed", "completed", "approved", "eligible"].includes(state ?? ""))
    return "teal";
  if (["failed", "error", "rejected", "recovery-required"].includes(state ?? "")) return "red";
  if (["running", "active", "accepted", "reserved"].includes(state ?? "")) return "indigo";
  if (["waiting", "paused", "pending", "cancelling"].includes(state ?? "")) return "yellow";
  return "gray";
}
