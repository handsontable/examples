import { webLightTheme } from '@fluentui/react-components';

// Fluent's CSS variables are camelCase (`--colorNeutralBackground1`), and the Theme API
// converts color values to kebab case, so `var(--colorNeutralBackground1)` would point to a
// variable that doesn't exist. Read the values from the Fluent theme object instead.

const colorsFluent = {
  palette: {
    50: webLightTheme.colorNeutralBackground1,
    100: webLightTheme.colorNeutralBackground2,
    200: webLightTheme.colorNeutralBackground3,
    300: webLightTheme.colorNeutralBackground4,
    400: webLightTheme.colorNeutralStroke2,
    500: webLightTheme.colorNeutralStroke1,
    600: webLightTheme.colorNeutralForeground3,
    700: webLightTheme.colorNeutralForeground2,
    800: webLightTheme.colorNeutralForeground1,
    900: webLightTheme.colorNeutralForeground1,
    950: webLightTheme.colorNeutralForeground1,
  },
  primary: {
    100: webLightTheme.colorBrandBackground,
    200: webLightTheme.colorBrandBackground2,
    300: webLightTheme.colorBrandBackgroundInverted,
    400: webLightTheme.colorBrandStroke1,
    500: webLightTheme.colorBrandForeground1,
    600: webLightTheme.colorBrandForeground2,
  },
  white: webLightTheme.colorNeutralBackground1,
  black: webLightTheme.colorNeutralForeground1,
  transparent: 'transparent',
};

export default colorsFluent;
