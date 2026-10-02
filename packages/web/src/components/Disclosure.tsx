import { Children, isValidElement, type ReactNode } from "react";
import { Accordion, Text } from "@mantine/core";

export function DisclosureTitle({ children }: { children?: ReactNode }) {
  return (
    <Text component="span" size="sm">
      {children}
    </Text>
  );
}

/** Shared library disclosure for evidence, preserving lazy artifact loading. */
export function Disclosure({
  children,
  open,
  onToggle,
  className,
}: {
  children?: ReactNode;
  open?: boolean;
  onToggle?: (opened: boolean) => void;
  className?: string;
}) {
  const parts = Children.toArray(children);
  const title = parts.find((child) => isValidElement(child) && child.type === DisclosureTitle);
  const content = parts.filter((child) => child !== title);
  return (
    <Accordion
      className={className}
      variant="separated"
      {...(onToggle
        ? { value: open ? "content" : null, onChange: (value) => onToggle(value !== null) }
        : { defaultValue: open ? "content" : null })}
    >
      <Accordion.Item value="content">
        <Accordion.Control>{title}</Accordion.Control>
        <Accordion.Panel>{content}</Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}
