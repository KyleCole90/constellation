import "react";

// A CSS custom property (`--name`) is a valid style key, so a style object sets one without a cast.
declare module "react" {
  interface CSSProperties {
    [variable: `--${string}`]: string | number | undefined;
  }
}
