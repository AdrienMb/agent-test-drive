import {
  Box,
  InputBase,
  Text,
  type ElementProps,
  type InputBaseProps,
} from "@mantine/core";
import { IconChevronDown } from "@tabler/icons-react";
import classes from "./SelectButton.module.css";

export interface SelectButtonProps
  extends
    InputBaseProps,
    ElementProps<"button", keyof InputBaseProps | "title"> {
  title: string;
  subtitle?: string;
}

/** A select-looking button that shows the current choice on two lines. */
export function SelectButton({ title, subtitle, ...props }: SelectButtonProps) {
  return (
    <InputBase
      component="button"
      type="button"
      multiline
      pointer
      rightSection={<IconChevronDown size={16} stroke={1.5} />}
      classNames={{ input: classes.input }}
      {...props}
    >
      <Box component="span" display="block" py={2}>
        <Text span display="block" fw={500} size="sm">
          {title}
        </Text>
        {subtitle && (
          <Text span display="block" c="dimmed" size="sm">
            {subtitle}
          </Text>
        )}
      </Box>
    </InputBase>
  );
}
