import { Box, Divider, Group, Paper, Stack, Text } from "@mantine/core";
import type { ReactNode } from "react";

export function PageHeader({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <>
      <Group px="lg" mih={62} py="sm" justify="space-between" wrap="wrap">
        <Text size="sm">{children}</Text>
        {actions}
      </Group>
      <Divider />
    </>
  );
}
export function WorkbenchPanel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack gap="xs" miw={0}>
      <Text size="xs" c="dimmed" tt="uppercase">
        {label}
      </Text>
      <Paper bg="var(--mantine-color-default)">
        <Stack gap="md">{children}</Stack>
      </Paper>
    </Stack>
  );
}
