// Handsontable's token catalogue — VENDORED VERBATIM, do not hand-edit (DEV-2199).
//
//   source : github.com/handsontable/theme-builder (private)
//   path   : src/utils/tokens.ts
//   ref    : develop
//   blob   : d6342f7b3a91ff7b5c65121aca2579669fb32385
//
// This is the backbone Theme Builder is built on and the reason demos.handsontable.com
// can replace it: 272 tokens across 5 common sections and 18 components, each with the
// label, description, `type`, select `options`, numeric `params` and `linkedTokens` the
// panel needs to render a *typed* control instead of a text box.
//
// It is copied byte-for-byte rather than summarised, because the previous hand-written
// list drifted: it invented `wrapperBorderRadius` and `wrapperBorderColor`, neither of
// which exists (the real names are `borderRadius` and `borderColor`), so those two
// controls silently did nothing.
//
// To refresh, re-copy the file and update the blob SHA above; verify with
//   { printf 'blob %d\0' $(wc -c < f); cat f; } | shasum -a 1
// Everything the runner adds sits in ./vocabulary.ts, which derives from this.

export type TokenType = "select" | "size" | "numeric" | "color";
export type Token = {
  key: string;
  label: string;
  type: TokenType;
  description: string;
  params?: {
    step: string;
    unit?: "px" | "%" | "s";
    min?: string;
    max?: string;
  };
  options?: {
    label: string;
    value: string;
  }[];
  linkedTokens?: string[];
};

export type TokenGroup = {
  label: string;
  description: string;
  tokens: Token[];
};

export const TOKENS_MAPPING: {
  [key: string]: {
    label: string;
    description: string;
    tokens?: Token[];
    groups?: TokenGroup[];
  }[];
} = {
  common: [
    {
      label: "Typography",
      description: "Typography variables",
      tokens: [
        {
          key: "fontFamily",
          label: "Font Family",
          type: "select",
          options: [
            { label: "Inter", value: "Inter" },
            { label: "Roboto", value: "Roboto" },
            { label: "Open Sans", value: "Open Sans" },
            { label: "Lato", value: "Lato" },
            { label: "Montserrat", value: "Montserrat" },
            { label: "Poppins", value: "Poppins" },
            { label: "Nunito Sans", value: "Nunito Sans" },
            { label: "Source Sans 3", value: "Source Sans 3" },
            { label: "DM Sans", value: "DM Sans" },
            { label: "Work Sans", value: "Work Sans" },
          ],
          description: "The font family to use for the table",
        },
        {
          key: "fontSize",
          label: "Font Size",
          type: "size",
          description: "The font size to use for the table",
        },
        {
          key: "lineHeight",
          label: "Line Height",
          type: "size",
          description: "The line height for text",
        },
        {
          key: "fontSizeSmall",
          label: "Font Size Small",
          type: "size",
          description: "The small font size variant",
        },
        {
          key: "lineHeightSmall",
          label: "Line Height Small",
          type: "size",
          description: "The small line height variant",
        },
        {
          key: "fontWeight",
          label: "Font Weight",
          type: "select",
          options: [
            { label: "100", value: "100" },
            { label: "200", value: "200" },
            { label: "300", value: "300" },
            { label: "400", value: "400" },
            { label: "500", value: "500" },
            { label: "600", value: "600" },
            { label: "700", value: "700" },
            { label: "800", value: "800" },
            { label: "900", value: "900" },
          ],
          description: "The font weight",
        },
        {
          key: "letterSpacing",
          label: "Letter Spacing",
          type: "size",
          description: "The spacing between letters",
        },
      ],
    },
    {
      label: "Colors",
      description: "Color variables",
      tokens: [
        {
          key: "borderColor",
          label: "Border Color",
          type: "color",
          description: "The default border color",
        },
        {
          key: "accentColor",
          label: "Accent Color",
          type: "color",
          description: "The accent color used for highlights and emphasis",
        },
        {
          key: "foregroundColor",
          label: "Foreground Color",
          type: "color",
          description: "The primary foreground/text color",
        },
        {
          key: "backgroundColor",
          label: "Background Color",
          type: "color",
          description: "The primary background color",
        },
        {
          key: "foregroundSecondaryColor",
          label: "Foreground Secondary Color",
          type: "color",
          description: "The secondary foreground/text color",
        },
        {
          key: "backgroundSecondaryColor",
          label: "Background Secondary Color",
          type: "color",
          description: "The secondary background color",
        },
        {
          key: "placeholderColor",
          label: "Placeholder Color",
          type: "color",
          description: "The color for placeholder text",
        },
        {
          key: "readOnlyColor",
          label: "Read Only Color",
          type: "color",
          description: "The color for read-only elements",
        },
        {
          key: "disabledColor",
          label: "Disabled Color",
          type: "color",
          description: "The color for disabled elements",
        },
      ],
    },
    {
      label: "Base",
      description: "Base variables",
      tokens: [
        {
          key: "gapSize",
          label: "Gap Size",
          type: "size",
          description: "The default gap size between elements",
        },
        {
          key: "iconSize",
          label: "Icon Size",
          type: "size",
          description: "The default size for icons",
        },
        {
          key: "borderRadius",
          label: "Border Radius",
          type: "size",
          description: "The default border radius",
        },
        {
          key: "tableTransition",
          label: "Table Transition",
          type: "numeric",
          params: {
            step: "0.01",
            unit: "s",
            min: "0",
          },
          description: "The transition timing for table animations",
        },
      ],
    },
    {
      label: "Bar",
      description: "Bar variables",
      tokens: [
        {
          key: "barForegroundColor",
          label: "Bar Foreground Color",
          type: "color",
          description: "The foreground color for bar elements",
        },
        {
          key: "barBackgroundColor",
          label: "Bar Background Color",
          type: "color",
          description: "The background color for bar elements",
        },
        {
          key: "barHorizontalPadding",
          label: "Bar Horizontal Padding",
          type: "size",
          description: "The horizontal padding for bar elements",
        },
        {
          key: "barVerticalPadding",
          label: "Bar Vertical Padding",
          type: "size",
          description: "The vertical padding for bar elements",
        },
      ],
    },
    {
      label: "Shadow",
      description: "Shadow variables",
      tokens: [
        {
          key: "shadowColor",
          label: "Shadow Color",
          type: "color",
          description: "The color of shadows",
        },
        {
          key: "shadowX",
          label: "Shadow X Offset",
          type: "size",
          description: "The horizontal offset of shadows",
        },
        {
          key: "shadowY",
          label: "Shadow Y Offset",
          type: "size",
          description: "The vertical offset of shadows",
        },
        {
          key: "shadowBlur",
          label: "Shadow Blur",
          type: "size",
          description: "The blur radius of shadows",
        },
        {
          key: "shadowOpacity",
          label: "Shadow Opacity",
          type: "numeric",
          params: {
            step: "1",
            unit: "%",
            min: "0",
            max: "100",
          },
          description: "The opacity of shadows",
        },
      ],
    },
  ],
  components: [
    {
      label: "Cell",
      description: "Cell variables",
      groups: [
        {
          label: "Padding",
          description: "Padding variables",
          tokens: [
            {
              key: "cellHorizontalPadding",
              label: "Horizontal Padding",
              type: "size",
              description: "The horizontal padding of the cell",
            },
            {
              key: "cellVerticalPadding",
              label: "Vertical Padding",
              type: "size",
              description: "The vertical padding of the cell",
            },
          ],
        },
        {
          label: "Border",
          description: "Border variables",
          tokens: [
            {
              key: "cellHorizontalBorderColor",
              label: "Horizontal Border Color",
              type: "color",
              description: "The color of the horizontal border of the cell",
            },
            {
              key: "cellVerticalBorderColor",
              label: "Vertical Border Color",
              type: "color",
              description: "The color of the vertical border of the cell",
            },
          ],
        },
        {
          label: "Selection",
          description: "Cell selection variables",
          tokens: [
            {
              key: "cellSelectionBorderColor",
              label: "Selection Border Color",
              type: "color",
              description: "The border color of the selected cell",
            },
            {
              key: "cellSelectionBackgroundColor",
              label: "Selection Background Color",
              type: "color",
              description: "The background color of the selected cell",
            },
          ],
        },
        {
          label: "State",
          description: "Cell state variables",
          tokens: [
            {
              key: "cellSuccessBackgroundColor",
              label: "Success Background Color",
              type: "color",
              description: "The background color for success state",
            },
            {
              key: "cellErrorBackgroundColor",
              label: "Error Background Color",
              type: "color",
              description: "The background color for error state",
            },
            {
              key: "cellReadOnlyBackgroundColor",
              label: "Read Only Background Color",
              type: "color",
              description: "The background color for read-only cells",
            },
          ],
        },
        {
          label: "Autofill",
          description: "Cell autofill variables",
          tokens: [
            {
              key: "cellAutofillSize",
              label: "Size",
              type: "size",
              description: "The size of the autofill handle",
            },
            {
              key: "cellAutofillHitAreaSize",
              label: "Hit Area Size",
              type: "size",
              description: "The hit area size of the autofill handle",
            },
            {
              key: "cellAutofillBorderWidth",
              label: "Border Width",
              type: "size",
              description: "The border width of the autofill handle",
            },
            {
              key: "cellAutofillBorderRadius",
              label: "Border Radius",
              type: "size",
              description: "The border radius of the autofill handle",
            },
            {
              key: "cellAutofillBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color of the autofill handle",
            },
            {
              key: "cellAutofillBackgroundColor",
              label: "Background Color",
              type: "color",
              description: "The background color of the autofill handle",
            },
            {
              key: "cellAutofillFillBorderColor",
              label: "Fill Border Color",
              type: "color",
              description: "The fill border color of the autofill handle",
            },
          ],
        },
        {
          label: "Editor",
          description: "Cell editor variables",
          tokens: [
            {
              key: "cellEditorBorderWidth",
              label: "Border Width",
              type: "size",
              description: "The border width of the cell editor",
            },
            {
              key: "cellEditorBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color of the cell editor",
            },
            {
              key: "cellEditorForegroundColor",
              label: "Foreground Color",
              type: "color",
              description: "The foreground color of the cell editor",
            },
            {
              key: "cellEditorBackgroundColor",
              label: "Background Color",
              type: "color",
              description: "The background color of the cell editor",
            },
            {
              key: "cellEditorShadowBlurRadius",
              label: "Shadow Blur Radius",
              type: "size",
              description: "The shadow blur radius of the cell editor",
            },
            {
              key: "cellEditorShadowColor",
              label: "Shadow Color",
              type: "color",
              description: "The shadow color of the cell editor",
            },
          ],
        },
        {
          label: "Mobile Handle",
          description: "Cell mobile handle variables",
          tokens: [
            {
              key: "cellMobileHandleSize",
              label: "Size",
              type: "size",
              description: "The size of the mobile handle",
            },
            {
              key: "cellMobileHandleBorderWidth",
              label: "Border Width",
              type: "size",
              description: "The border width of the mobile handle",
            },
            {
              key: "cellMobileHandleBorderRadius",
              label: "Border Radius",
              type: "size",
              description: "The border radius of the mobile handle",
            },
            {
              key: "cellMobileHandleBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color of the mobile handle",
            },
            {
              key: "cellMobileHandleBackgroundColor",
              label: "Background Color",
              type: "color",
              description: "The background color of the mobile handle",
            },
            {
              key: "cellMobileHandleBackgroundOpacity",
              label: "Background Opacity",
              type: "numeric",
              params: { step: "1", unit: "%", min: "0", max: "100" },
              description: "The background opacity of the mobile handle",
            },
          ],
        },
      ],
    },
    {
      label: "Header",
      description: "Header variables",
      groups: [
        {
          label: "Base",
          description: "Base variables",
          tokens: [
            {
              key: "headerFontWeight",
              label: "Font Weight",
              type: "select",
              options: [
                { label: "100", value: "100" },
                { label: "200", value: "200" },
                { label: "300", value: "300" },
                { label: "400", value: "400" },
                { label: "500", value: "500" },
                { label: "600", value: "600" },
                { label: "700", value: "700" },
                { label: "800", value: "800" },
                { label: "900", value: "900" },
              ],
              description: "The font weight of the header",
            },
            {
              key: "headerForegroundColor",
              label: "Foreground Color",
              type: "color",
              description: "The foreground color of the header",
              linkedTokens: ["headerRowForegroundColor"],
            },
            {
              key: "headerBackgroundColor",
              label: "Background Color",
              type: "color",
              description: "The background color of the header",
              linkedTokens: ["headerRowBackgroundColor"],
            },
          ],
        },
        {
          label: "Highlighted",
          description: "Header highlighted variables",
          tokens: [
            {
              key: "headerHighlightedShadowSize",
              label: "Shadow Size",
              type: "size",
              description: "The shadow size when header is highlighted",
            },
            {
              key: "headerHighlightedForegroundColor",
              label: "Foreground Color",
              type: "color",
              description: "The foreground color when header is highlighted",
              linkedTokens: ["headerRowHighlightedForegroundColor"],
            },
            {
              key: "headerHighlightedBackgroundColor",
              label: "Background Color",
              type: "color",
              description: "The background color when header is highlighted",
              linkedTokens: ["headerRowHighlightedBackgroundColor"],
            },
          ],
        },
        {
          label: "Active",
          description: "Header active variables",
          tokens: [
            {
              key: "headerActiveBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color when header is active",
            },
            {
              key: "headerActiveForegroundColor",
              label: "Foreground Color",
              type: "color",
              description: "The foreground color when header is active",
              linkedTokens: ["headerRowActiveForegroundColor"],
            },
            {
              key: "headerActiveBackgroundColor",
              label: "Background Color",
              type: "color",
              description: "The background color when header is active",
              linkedTokens: ["headerRowActiveBackgroundColor"],
            },
          ],
        },
        {
          label: "Filter",
          description: "Header filter variables",
          tokens: [
            {
              key: "headerFilterBackgroundColor",
              label: "Background Color",
              type: "color",
              description: "The background color of the header filter",
            },
          ],
        },
      ],
    },
    {
      label: "Rows",
      description: "Rows variables",
      groups: [
        {
          label: "Header",
          description: "Rows variables",
          tokens: [
            {
              key: "headerRowForegroundColor",
              label: "Foreground Color",
              type: "color",
              description: "The foreground color of the header row",
            },
            {
              key: "headerRowBackgroundColor",
              label: "Background Color",
              type: "color",
              description: "The background color of the header row",
            },
            {
              key: "rowHeaderOddBackgroundColor",
              label: "Odd Background Color",
              type: "color",
              description: "The background color of odd header rows",
            },
            {
              key: "rowHeaderEvenBackgroundColor",
              label: "Even Background Color",
              type: "color",
              description: "The background color of even header rows",
            },
            {
              key: "headerRowHighlightedForegroundColor",
              label: "Highlighted Foreground Color",
              type: "color",
              description:
                "The foreground color when header row is highlighted",
            },
            {
              key: "headerRowHighlightedBackgroundColor",
              label: "Highlighted Background Color",
              type: "color",
              description:
                "The background color when header row is highlighted",
            },
            {
              key: "headerRowActiveForegroundColor",
              label: "Active Foreground Color",
              type: "color",
              description: "The foreground color when header row is active",
            },
            {
              key: "headerRowActiveBackgroundColor",
              label: "Active Background Color",
              type: "color",
              description: "The background color when header row is active",
            },
          ],
        },
        {
          label: "Cell",
          description: "Cell variables",
          tokens: [
            {
              key: "rowCellOddBackgroundColor",
              label: "Cell Odd Background Color",
              type: "color",
              description: "The background color of odd cell rows",
            },
            {
              key: "rowCellEvenBackgroundColor",
              label: "Cell Even Background Color",
              type: "color",
              description: "The background color of even cell rows",
            },
          ],
        },
      ],
    },
    {
      label: "Buttons",
      description: "Button variables",
      groups: [
        {
          label: "Base",
          description: "Base variables",
          tokens: [
            {
              key: "buttonBorderRadius",
              label: "Border Radius",
              type: "size",
              description: "The border radius of buttons",
            },
            {
              key: "buttonHorizontalPadding",
              label: "Horizontal Padding",
              type: "size",
              description: "The horizontal padding of buttons",
            },
            {
              key: "buttonVerticalPadding",
              label: "Vertical Padding",
              type: "size",
              description: "The vertical padding of buttons",
            },
          ],
        },
        {
          label: "Primary Button",
          description: "Primary button variables",
          tokens: [
            {
              key: "primaryButtonBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color of the primary button",
            },
            {
              key: "primaryButtonForegroundColor",
              label: "Foreground Color",
              type: "color",
              description: "The foreground color of the primary button",
            },
            {
              key: "primaryButtonBackgroundColor",
              label: "Background Color",
              type: "color",
              description: "The background color of the primary button",
            },
          ],
        },
        {
          label: "Primary Button Disabled",
          description: "Primary button disabled variables",
          tokens: [
            {
              key: "primaryButtonDisabledBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color when primary button is disabled",
            },
            {
              key: "primaryButtonDisabledForegroundColor",
              label: "Foreground Color",
              type: "color",
              description:
                "The foreground color when primary button is disabled",
            },
            {
              key: "primaryButtonDisabledBackgroundColor",
              label: "Background Color",
              type: "color",
              description:
                "The background color when primary button is disabled",
            },
          ],
        },
        {
          label: "Primary Button Hover",
          description: "Primary button hover variables",
          tokens: [
            {
              key: "primaryButtonHoverBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color when primary button is hovered",
            },
            {
              key: "primaryButtonHoverForegroundColor",
              label: "Foreground Color",
              type: "color",
              description:
                "The foreground color when primary button is hovered",
            },
            {
              key: "primaryButtonHoverBackgroundColor",
              label: "Background Color",
              type: "color",
              description:
                "The background color when primary button is hovered",
            },
          ],
        },
        {
          label: "Primary Button Focus",
          description: "Primary button focus variables",
          tokens: [
            {
              key: "primaryButtonFocusBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color when primary button is focused",
            },
            {
              key: "primaryButtonFocusForegroundColor",
              label: "Foreground Color",
              type: "color",
              description:
                "The foreground color when primary button is focused",
            },
            {
              key: "primaryButtonFocusBackgroundColor",
              label: "Background Color",
              type: "color",
              description:
                "The background color when primary button is focused",
            },
          ],
        },
        {
          label: "Secondary Button",
          description: "Secondary button variables",
          tokens: [
            {
              key: "secondaryButtonBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color of the secondary button",
            },
            {
              key: "secondaryButtonForegroundColor",
              label: "Foreground Color",
              type: "color",
              description: "The foreground color of the secondary button",
            },
            {
              key: "secondaryButtonBackgroundColor",
              label: "Background Color",
              type: "color",
              description: "The background color of the secondary button",
            },
          ],
        },
        {
          label: "Secondary Button Disabled",
          description: "Secondary button disabled variables",
          tokens: [
            {
              key: "secondaryButtonDisabledBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color when secondary button is disabled",
            },
            {
              key: "secondaryButtonDisabledForegroundColor",
              label: "Foreground Color",
              type: "color",
              description:
                "The foreground color when secondary button is disabled",
            },
            {
              key: "secondaryButtonDisabledBackgroundColor",
              label: "Background Color",
              type: "color",
              description:
                "The background color when secondary button is disabled",
            },
          ],
        },
        {
          label: "Secondary Button Hover",
          description: "Secondary button hover variables",
          tokens: [
            {
              key: "secondaryButtonHoverBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color when secondary button is hovered",
            },
            {
              key: "secondaryButtonHoverForegroundColor",
              label: "Foreground Color",
              type: "color",
              description:
                "The foreground color when secondary button is hovered",
            },
            {
              key: "secondaryButtonHoverBackgroundColor",
              label: "Background Color",
              type: "color",
              description:
                "The background color when secondary button is hovered",
            },
          ],
        },
        {
          label: "Secondary Button Focus",
          description: "Secondary button focus variables",
          tokens: [
            {
              key: "secondaryButtonFocusBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color when secondary button is focused",
            },
            {
              key: "secondaryButtonFocusForegroundColor",
              label: "Foreground Color",
              type: "color",
              description:
                "The foreground color when secondary button is focused",
            },
            {
              key: "secondaryButtonFocusBackgroundColor",
              label: "Background Color",
              type: "color",
              description:
                "The background color when secondary button is focused",
            },
          ],
        },
        {
          label: "Icon Button",
          description: "Icon button variables",
          tokens: [
            {
              key: "iconButtonBorderRadius",
              label: "Border Radius",
              type: "size",
              description: "The border radius of the icon button",
            },
            {
              key: "iconButtonLargeBorderRadius",
              label: "Large Border Radius",
              type: "size",
              description: "The large border radius of the icon button",
            },
            {
              key: "iconButtonLargePadding",
              label: "Large Padding",
              type: "size",
              description: "The large padding of the icon button",
            },
            {
              key: "iconButtonBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color of the icon button",
            },
            {
              key: "iconButtonBackgroundColor",
              label: "Background Color",
              type: "color",
              description: "The background color of the icon button",
            },
            {
              key: "iconButtonIconColor",
              label: "Icon Color",
              type: "color",
              description: "The icon color of the icon button",
            },
          ],
        },
        {
          label: "Icon Button Hover",
          description: "Icon button hover variables",
          tokens: [
            {
              key: "iconButtonHoverBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color when icon button is hovered",
            },
            {
              key: "iconButtonHoverBackgroundColor",
              label: "Background Color",
              type: "color",
              description: "The background color when icon button is hovered",
            },
            {
              key: "iconButtonHoverIconColor",
              label: "Icon Color",
              type: "color",
              description: "The icon color when icon button is hovered",
            },
          ],
        },
        {
          label: "Icon Button Active",
          description: "Icon button active variables",
          tokens: [
            {
              key: "iconButtonActiveBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color when icon button is active",
            },
            {
              key: "iconButtonActiveBackgroundColor",
              label: "Background Color",
              type: "color",
              description: "The background color when icon button is active",
            },
            {
              key: "iconButtonActiveIconColor",
              label: "Icon Color",
              type: "color",
              description: "The icon color when icon button is active",
            },
          ],
        },
        {
          label: "Icon Button Active Hover",
          description: "Icon button active hover variables",
          tokens: [
            {
              key: "iconButtonActiveHoverBorderColor",
              label: "Border Color",
              type: "color",
              description:
                "The border color when icon button is active and hovered",
            },
            {
              key: "iconButtonActiveHoverBackgroundColor",
              label: "Background Color",
              type: "color",
              description:
                "The background color when icon button is active and hovered",
            },
            {
              key: "iconButtonActiveHoverIconColor",
              label: "Icon Color",
              type: "color",
              description:
                "The icon color when icon button is active and hovered",
            },
          ],
        },
        {
          label: "Collapse Button Open",
          description: "Collapse button open variables",
          tokens: [
            {
              key: "collapseButtonBorderRadius",
              label: "Border Radius",
              type: "size",
              description: "The border radius of the collapse button",
            },
            {
              key: "collapseButtonOpenBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color when collapse button is open",
            },
            {
              key: "collapseButtonOpenBackgroundColor",
              label: "Background Color",
              type: "color",
              description: "The background color when collapse button is open",
            },
            {
              key: "collapseButtonOpenIconColor",
              label: "Icon Color",
              type: "color",
              description: "The icon color when collapse button is open",
            },
            {
              key: "collapseButtonOpenIconActiveColor",
              label: "Icon Active Color",
              type: "color",
              description: "The icon active color when collapse button is open",
            },
          ],
        },
        {
          label: "Collapse Button Open Hover",
          description: "Collapse button open hover variables",
          tokens: [
            {
              key: "collapseButtonOpenHoverBorderColor",
              label: "Border Color",
              type: "color",
              description:
                "The border color when collapse button open is hovered",
            },
            {
              key: "collapseButtonOpenHoverBackgroundColor",
              label: "Background Color",
              type: "color",
              description:
                "The background color when collapse button open is hovered",
            },
            {
              key: "collapseButtonOpenHoverIconColor",
              label: "Icon Color",
              type: "color",
              description:
                "The icon color when collapse button open is hovered",
            },
            {
              key: "collapseButtonOpenHoverIconActiveColor",
              label: "Icon Active Color",
              type: "color",
              description:
                "The icon active color when collapse button open is hovered",
            },
          ],
        },
        {
          label: "Collapse Button Close",
          description: "Collapse button close variables",
          tokens: [
            {
              key: "collapseButtonCloseBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color when collapse button is closed",
            },
            {
              key: "collapseButtonCloseBackgroundColor",
              label: "Background Color",
              type: "color",
              description:
                "The background color when collapse button is closed",
            },
            {
              key: "collapseButtonCloseIconColor",
              label: "Icon Color",
              type: "color",
              description: "The icon color when collapse button is closed",
            },
            {
              key: "collapseButtonCloseIconActiveColor",
              label: "Icon Active Color",
              type: "color",
              description:
                "The icon active color when collapse button is closed",
            },
          ],
        },
        {
          label: "Collapse Button Close Hover",
          description: "Collapse button close hover variables",
          tokens: [
            {
              key: "collapseButtonCloseHoverBorderColor",
              label: "Border Color",
              type: "color",
              description:
                "The border color when collapse button close is hovered",
            },
            {
              key: "collapseButtonCloseHoverBackgroundColor",
              label: "Background Color",
              type: "color",
              description:
                "The background color when collapse button close is hovered",
            },
            {
              key: "collapseButtonCloseHoverIconColor",
              label: "Icon Color",
              type: "color",
              description:
                "The icon color when collapse button close is hovered",
            },
            {
              key: "collapseButtonCloseHoverIconActiveColor",
              label: "Icon Active Color",
              type: "color",
              description:
                "The icon active color when collapse button close is hovered",
            },
          ],
        },
      ],
    },
    {
      label: "Links",
      description: "Link variables",
      groups: [
        {
          label: "Base",
          description: "Base variables",
          tokens: [
            {
              key: "linkColor",
              label: "Color",
              type: "color",
              description: "The color of links",
            },
            {
              key: "linkHoverColor",
              label: "Hover Color",
              type: "color",
              description: "The color of links when hovered",
            },
          ],
        },
      ],
    },
    {
      label: "Inputs",
      description: "Input variables",
      groups: [
        {
          label: "Base",
          description: "Base variables",
          tokens: [
            {
              key: "inputBorderWidth",
              label: "Border Width",
              type: "size",
              description: "The border width of inputs",
            },
            {
              key: "inputBorderRadius",
              label: "Border Radius",
              type: "size",
              description: "The border radius of inputs",
            },
            {
              key: "inputHorizontalPadding",
              label: "Horizontal Padding",
              type: "size",
              description: "The horizontal padding of inputs",
            },
            {
              key: "inputVerticalPadding",
              label: "Vertical Padding",
              type: "size",
              description: "The vertical padding of inputs",
            },
            {
              key: "inputBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color of inputs",
            },
            {
              key: "inputForegroundColor",
              label: "Foreground Color",
              type: "color",
              description: "The foreground color of inputs",
            },
            {
              key: "inputBackgroundColor",
              label: "Background Color",
              type: "color",
              description: "The background color of inputs",
            },
          ],
        },
        {
          label: "Hover",
          description: "Input hover variables",
          tokens: [
            {
              key: "inputHoverBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color when input is hovered",
            },
            {
              key: "inputHoverForegroundColor",
              label: "Foreground Color",
              type: "color",
              description: "The foreground color when input is hovered",
            },
            {
              key: "inputHoverBackgroundColor",
              label: "Background Color",
              type: "color",
              description: "The background color when input is hovered",
            },
          ],
        },
        {
          label: "Disabled",
          description: "Input disabled variables",
          tokens: [
            {
              key: "inputDisabledBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color when input is disabled",
            },
            {
              key: "inputDisabledForegroundColor",
              label: "Foreground Color",
              type: "color",
              description: "The foreground color when input is disabled",
            },
            {
              key: "inputDisabledBackgroundColor",
              label: "Background Color",
              type: "color",
              description: "The background color when input is disabled",
            },
          ],
        },
        {
          label: "Focus",
          description: "Input focus variables",
          tokens: [
            {
              key: "inputFocusBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color when input is focused",
            },
            {
              key: "inputFocusForegroundColor",
              label: "Foreground Color",
              type: "color",
              description: "The foreground color when input is focused",
            },
            {
              key: "inputFocusBackgroundColor",
              label: "Background Color",
              type: "color",
              description: "The background color when input is focused",
            },
          ],
        },
      ],
    },
    {
      label: "Checkboxes",
      description: "Checkbox variables",
      groups: [
        {
          label: "Base",
          description: "Base variables",
          tokens: [
            {
              key: "checkboxSize",
              label: "Size",
              type: "size",
              description: "The size of the checkbox",
            },
            {
              key: "checkboxBorderRadius",
              label: "Border Radius",
              type: "size",
              description: "The border radius of the checkbox",
            },
            {
              key: "checkboxBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color of the checkbox",
            },
            {
              key: "checkboxBackgroundColor",
              label: "Background Color",
              type: "color",
              description: "The background color of the checkbox",
            },
            {
              key: "checkboxIconColor",
              label: "Icon Color",
              type: "color",
              description: "The icon color of the checkbox",
            },
          ],
        },
        {
          label: "Focus",
          description: "Checkbox focus variables",
          tokens: [
            {
              key: "checkboxFocusBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color when checkbox is focused",
            },
            {
              key: "checkboxFocusBackgroundColor",
              label: "Background Color",
              type: "color",
              description: "The background color when checkbox is focused",
            },
            {
              key: "checkboxFocusIconColor",
              label: "Icon Color",
              type: "color",
              description: "The icon color when checkbox is focused",
            },
            {
              key: "checkboxFocusRingColor",
              label: "Focus Ring Color",
              type: "color",
              description: "The focus ring color of the checkbox",
            },
          ],
        },
        {
          label: "Disabled",
          description: "Checkbox disabled variables",
          tokens: [
            {
              key: "checkboxDisabledBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color when checkbox is disabled",
            },
            {
              key: "checkboxDisabledBackgroundColor",
              label: "Background Color",
              type: "color",
              description: "The background color when checkbox is disabled",
            },
            {
              key: "checkboxDisabledIconColor",
              label: "Icon Color",
              type: "color",
              description: "The icon color when checkbox is disabled",
            },
          ],
        },
        {
          label: "Checked",
          description: "Checkbox checked variables",
          tokens: [
            {
              key: "checkboxCheckedBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color when checkbox is checked",
            },
            {
              key: "checkboxCheckedBackgroundColor",
              label: "Background Color",
              type: "color",
              description: "The background color when checkbox is checked",
            },
            {
              key: "checkboxCheckedIconColor",
              label: "Icon Color",
              type: "color",
              description: "The icon color when checkbox is checked",
            },
            {
              key: "checkboxCheckedFocusBorderColor",
              label: "Focus Border Color",
              type: "color",
              description:
                "The border color when checkbox is checked and focused",
            },
            {
              key: "checkboxCheckedFocusBackgroundColor",
              label: "Focus Background Color",
              type: "color",
              description:
                "The background color when checkbox is checked and focused",
            },
            {
              key: "checkboxCheckedFocusIconColor",
              label: "Focus Icon Color",
              type: "color",
              description:
                "The icon color when checkbox is checked and focused",
            },
            {
              key: "checkboxCheckedDisabledBorderColor",
              label: "Disabled Border Color",
              type: "color",
              description:
                "The border color when checkbox is checked and disabled",
            },
            {
              key: "checkboxCheckedDisabledBackgroundColor",
              label: "Disabled Background Color",
              type: "color",
              description:
                "The background color when checkbox is checked and disabled",
            },
            {
              key: "checkboxCheckedDisabledIconColor",
              label: "Disabled Icon Color",
              type: "color",
              description:
                "The icon color when checkbox is checked and disabled",
            },
          ],
        },
        {
          label: "Indeterminate",
          description: "Checkbox indeterminate variables",
          tokens: [
            {
              key: "checkboxIndeterminateBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color when checkbox is indeterminate",
            },
            {
              key: "checkboxIndeterminateBackgroundColor",
              label: "Background Color",
              type: "color",
              description:
                "The background color when checkbox is indeterminate",
            },
            {
              key: "checkboxIndeterminateIconColor",
              label: "Icon Color",
              type: "color",
              description: "The icon color when checkbox is indeterminate",
            },
            {
              key: "checkboxIndeterminateFocusBorderColor",
              label: "Focus Border Color",
              type: "color",
              description:
                "The border color when checkbox is indeterminate and focused",
            },
            {
              key: "checkboxIndeterminateFocusBackgroundColor",
              label: "Focus Background Color",
              type: "color",
              description:
                "The background color when checkbox is indeterminate and focused",
            },
            {
              key: "checkboxIndeterminateFocusIconColor",
              label: "Focus Icon Color",
              type: "color",
              description:
                "The icon color when checkbox is indeterminate and focused",
            },
            {
              key: "checkboxIndeterminateDisabledBorderColor",
              label: "Disabled Border Color",
              type: "color",
              description:
                "The border color when checkbox is indeterminate and disabled",
            },
            {
              key: "checkboxIndeterminateDisabledBackgroundColor",
              label: "Disabled Background Color",
              type: "color",
              description:
                "The background color when checkbox is indeterminate and disabled",
            },
            {
              key: "checkboxIndeterminateDisabledIconColor",
              label: "Disabled Icon Color",
              type: "color",
              description:
                "The icon color when checkbox is indeterminate and disabled",
            },
          ],
        },
      ],
    },
    {
      label: "Radio Buttons",
      description: "Radio button variables",
      groups: [
        {
          label: "Base",
          description: "Base variables",
          tokens: [
            {
              key: "radioSize",
              label: "Size",
              type: "size",
              description: "The size of the radio button",
            },
            {
              key: "radioBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color of the radio button",
            },
            {
              key: "radioBackgroundColor",
              label: "Background Color",
              type: "color",
              description: "The background color of the radio button",
            },
            {
              key: "radioIconColor",
              label: "Icon Color",
              type: "color",
              description: "The icon color of the radio button",
            },
          ],
        },
        {
          label: "Focus",
          description: "Radio button focus variables",
          tokens: [
            {
              key: "radioFocusBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color when radio is focused",
            },
            {
              key: "radioFocusBackgroundColor",
              label: "Background Color",
              type: "color",
              description: "The background color when radio is focused",
            },
            {
              key: "radioFocusIconColor",
              label: "Icon Color",
              type: "color",
              description: "The icon color when radio is focused",
            },
            {
              key: "radioFocusRingColor",
              label: "Focus Ring Color",
              type: "color",
              description: "The focus ring color of the radio button",
            },
          ],
        },
        {
          label: "Disabled",
          description: "Radio button disabled variables",
          tokens: [
            {
              key: "radioDisabledBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color when radio is disabled",
            },
            {
              key: "radioDisabledBackgroundColor",
              label: "Background Color",
              type: "color",
              description: "The background color when radio is disabled",
            },
            {
              key: "radioDisabledIconColor",
              label: "Icon Color",
              type: "color",
              description: "The icon color when radio is disabled",
            },
          ],
        },
        {
          label: "Checked",
          description: "Radio button checked variables",
          tokens: [
            {
              key: "radioCheckedBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color when radio is checked",
            },
            {
              key: "radioCheckedBackgroundColor",
              label: "Background Color",
              type: "color",
              description: "The background color when radio is checked",
            },
            {
              key: "radioCheckedIconColor",
              label: "Icon Color",
              type: "color",
              description: "The icon color when radio is checked",
            },
            {
              key: "radioCheckedFocusBorderColor",
              label: "Focus Border Color",
              type: "color",
              description: "The border color when radio is checked and focused",
            },
            {
              key: "radioCheckedFocusBackgroundColor",
              label: "Focus Background Color",
              type: "color",
              description:
                "The background color when radio is checked and focused",
            },
            {
              key: "radioCheckedFocusIconColor",
              label: "Focus Icon Color",
              type: "color",
              description: "The icon color when radio is checked and focused",
            },
            {
              key: "radioCheckedDisabledBorderColor",
              label: "Disabled Border Color",
              type: "color",
              description:
                "The border color when radio is checked and disabled",
            },
            {
              key: "radioCheckedDisabledBackgroundColor",
              label: "Disabled Background Color",
              type: "color",
              description:
                "The background color when radio is checked and disabled",
            },
            {
              key: "radioCheckedDisabledIconColor",
              label: "Disabled Icon Color",
              type: "color",
              description: "The icon color when radio is checked and disabled",
            },
          ],
        },
      ],
    },
    {
      label: "Move",
      description: "Move variables",
      groups: [
        {
          label: "Move",
          description: "Move variables",
          tokens: [
            {
              key: "moveBacklightColor",
              label: "Backlight Color",
              type: "color",
              description: "The color of the move backlight",
            },
            {
              key: "moveBacklightOpacity",
              label: "Backlight Opacity",
              type: "numeric",
              params: { step: "1", unit: "%", min: "0", max: "100" },
              description: "The opacity of the move backlight",
            },
            {
              key: "moveIndicatorColor",
              label: "Indicator Color",
              type: "color",
              description: "The color of the move indicator",
            },
          ],
        },
      ],
    },
    {
      label: "Resize",
      description: "Resize variables",
      groups: [
        {
          label: "Resize Indicator",
          description: "Resize indicator variables",
          tokens: [
            {
              key: "resizeIndicatorColor",
              label: "Color",
              type: "color",
              description: "The color of the resize indicator",
            },
          ],
        },
      ],
    },
    {
      label: "Hidden",
      description: "Hidden indicator variables",
      groups: [
        {
          label: "Hidden Indicator",
          description: "Hidden indicator variables",
          tokens: [
            {
              key: "hiddenIndicatorColor",
              label: "Color",
              type: "color",
              description: "The color of the hidden indicator",
            },
          ],
        },
      ],
    },
    {
      label: "Menu",
      description: "Menu variables",
      groups: [
        {
          label: "Layout",
          description: "Menu size and spacing",
          tokens: [
            {
              key: "menuBorderWidth",
              label: "Border Width",
              type: "size",
              description: "The border width of the menu",
            },
            {
              key: "menuBorderRadius",
              label: "Border Radius",
              type: "size",
              description: "The border radius of the menu",
            },
            {
              key: "menuHorizontalPadding",
              label: "Horizontal Padding",
              type: "size",
              description: "The horizontal padding of the menu",
            },
            {
              key: "menuVerticalPadding",
              label: "Vertical Padding",
              type: "size",
              description: "The vertical padding of the menu",
            },
            {
              key: "menuItemHorizontalPadding",
              label: "Item Horizontal Padding",
              type: "size",
              description: "The horizontal padding of menu items",
            },
            {
              key: "menuItemVerticalPadding",
              label: "Item Vertical Padding",
              type: "size",
              description: "The vertical padding of menu items",
            },
          ],
        },
        {
          label: "Border & Shadow",
          description: "Menu border and shadow",
          tokens: [
            {
              key: "menuBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color of the menu",
            },
            {
              key: "menuShadowX",
              label: "Shadow X",
              type: "size",
              description: "The horizontal offset of the menu shadow",
            },
            {
              key: "menuShadowY",
              label: "Shadow Y",
              type: "size",
              description: "The vertical offset of the menu shadow",
            },
            {
              key: "menuShadowBlur",
              label: "Shadow Blur",
              type: "size",
              description: "The blur radius of the menu shadow",
            },
            {
              key: "menuShadowColor",
              label: "Shadow Color",
              type: "color",
              description: "The color of the menu shadow",
            },
            {
              key: "menuShadowOpacity",
              label: "Shadow Opacity",
              type: "numeric",
              params: { step: "1", unit: "%", min: "0", max: "100" },
              description: "The opacity of the menu shadow",
            },
          ],
        },
        {
          label: "Item States",
          description: "Menu item hover and active styles",
          tokens: [
            {
              key: "menuItemHoverColor",
              label: "Item Hover Color",
              type: "color",
              description: "The color when menu item is hovered",
            },
            {
              key: "menuItemHoverColorOpacity",
              label: "Item Hover Color Opacity",
              type: "numeric",
              params: { step: "1", unit: "%", min: "0", max: "100" },
              description: "The opacity of the menu item hover color",
            },
            {
              key: "menuItemActiveColor",
              label: "Item Active Color",
              type: "color",
              description: "The color when menu item is active",
            },
            {
              key: "menuItemActiveColorOpacity",
              label: "Item Active Color Opacity",
              type: "numeric",
              params: { step: "1", unit: "%", min: "0", max: "100" },
              description: "The opacity of the menu item active color",
            },
          ],
        },
      ],
    },
    {
      label: "Comments",
      description: "Comments variables",
      groups: [
        {
          label: "Textarea Layout",
          description: "Comments textarea size and spacing",
          tokens: [
            {
              key: "commentsTextareaHorizontalPadding",
              label: "Textarea Horizontal Padding",
              type: "size",
              description: "The horizontal padding of the comments textarea",
            },
            {
              key: "commentsTextareaVerticalPadding",
              label: "Textarea Vertical Padding",
              type: "size",
              description: "The vertical padding of the comments textarea",
            },
            {
              key: "commentsTextareaBorderWidth",
              label: "Textarea Border Width",
              type: "size",
              description: "The border width of the comments textarea",
            },
          ],
        },
        {
          label: "Textarea Base",
          description: "Comments textarea colors",
          tokens: [
            {
              key: "commentsTextareaBorderColor",
              label: "Textarea Border Color",
              type: "color",
              description: "The border color of the comments textarea",
            },
            {
              key: "commentsTextareaForegroundColor",
              label: "Textarea Foreground Color",
              type: "color",
              description: "The foreground color of the comments textarea",
            },
            {
              key: "commentsTextareaBackgroundColor",
              label: "Textarea Background Color",
              type: "color",
              description: "The background color of the comments textarea",
            },
          ],
        },
        {
          label: "Textarea Focus",
          description: "Comments textarea focus state",
          tokens: [
            {
              key: "commentsTextareaFocusBorderWidth",
              label: "Textarea Focus Border Width",
              type: "size",
              description: "The border width when comments textarea is focused",
            },
            {
              key: "commentsTextareaFocusBorderColor",
              label: "Textarea Focus Border Color",
              type: "color",
              description: "The border color when comments textarea is focused",
            },
            {
              key: "commentsTextareaFocusForegroundColor",
              label: "Textarea Focus Foreground Color",
              type: "color",
              description:
                "The foreground color when comments textarea is focused",
            },
            {
              key: "commentsTextareaFocusBackgroundColor",
              label: "Textarea Focus Background Color",
              type: "color",
              description:
                "The background color when comments textarea is focused",
            },
          ],
        },
        {
          label: "Indicator",
          description: "Comments indicator",
          tokens: [
            {
              key: "commentsIndicatorSize",
              label: "Indicator Size",
              type: "size",
              description: "The size of the comments indicator",
            },
            {
              key: "commentsIndicatorColor",
              label: "Indicator Color",
              type: "color",
              description: "The color of the comments indicator",
            },
          ],
        },
      ],
    },
    {
      label: "License",
      description: "License variables",
      groups: [
        {
          label: "Layout",
          description: "License bar spacing",
          tokens: [
            {
              key: "licenseHorizontalPadding",
              label: "Horizontal Padding",
              type: "size",
              description: "The horizontal padding of the license bar",
            },
            {
              key: "licenseVerticalPadding",
              label: "Vertical Padding",
              type: "size",
              description: "The vertical padding of the license bar",
            },
          ],
        },
        {
          label: "Colors",
          description: "License bar colors",
          tokens: [
            {
              key: "licenseForegroundColor",
              label: "Foreground Color",
              type: "color",
              description: "The foreground color of the license bar",
            },
            {
              key: "licenseBackgroundColor",
              label: "Background Color",
              type: "color",
              description: "The background color of the license bar",
            },
          ],
        },
      ],
    },
    {
      label: "Pagination",
      description: "Pagination variables",
      groups: [
        {
          label: "Bar Colors",
          description: "Pagination bar colors",
          tokens: [
            {
              key: "paginationBarForegroundColor",
              label: "Bar Foreground Color",
              type: "color",
              description: "The foreground color of the pagination bar",
            },
            {
              key: "paginationBarBackgroundColor",
              label: "Bar Background Color",
              type: "color",
              description: "The background color of the pagination bar",
            },
          ],
        },
        {
          label: "Bar Layout",
          description: "Pagination bar spacing",
          tokens: [
            {
              key: "paginationBarHorizontalPadding",
              label: "Bar Horizontal Padding",
              type: "size",
              description: "The horizontal padding of the pagination bar",
            },
            {
              key: "paginationBarVerticalPadding",
              label: "Bar Vertical Padding",
              type: "size",
              description: "The vertical padding of the pagination bar",
            },
          ],
        },
        {
          label: "Navigation Button",
          description: "Pagination navigation button variables",
          tokens: [
            {
              key: "paginationButtonBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color of the pagination navigation button",
            },
            {
              key: "paginationButtonForegroundColor",
              label: "Foreground Color",
              type: "color",
              description: "The foreground (icon) color of the pagination navigation button",
            },
            {
              key: "paginationButtonBackgroundColor",
              label: "Background Color",
              type: "color",
              description: "The background color of the pagination navigation button",
            },
          ],
        },
        {
          label: "Navigation Button Hover",
          description: "Pagination navigation button hover variables",
          tokens: [
            {
              key: "paginationButtonHoverBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color when the pagination navigation button is hovered",
            },
            {
              key: "paginationButtonHoverForegroundColor",
              label: "Foreground Color",
              type: "color",
              description: "The foreground color when the pagination navigation button is hovered",
            },
            {
              key: "paginationButtonHoverBackgroundColor",
              label: "Background Color",
              type: "color",
              description: "The background color when the pagination navigation button is hovered",
            },
          ],
        },
        {
          label: "Navigation Button Focus",
          description: "Pagination navigation button focus variables",
          tokens: [
            {
              key: "paginationButtonFocusBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color when the pagination navigation button is focused",
            },
            {
              key: "paginationButtonFocusForegroundColor",
              label: "Foreground Color",
              type: "color",
              description: "The foreground color when the pagination navigation button is focused",
            },
            {
              key: "paginationButtonFocusBackgroundColor",
              label: "Background Color",
              type: "color",
              description: "The background color when the pagination navigation button is focused",
            },
          ],
        },
        {
          label: "Navigation Button Disabled",
          description: "Pagination navigation button disabled variables",
          tokens: [
            {
              key: "paginationButtonDisabledBorderColor",
              label: "Border Color",
              type: "color",
              description: "The border color when the pagination navigation button is disabled",
            },
            {
              key: "paginationButtonDisabledForegroundColor",
              label: "Foreground Color",
              type: "color",
              description: "The foreground color when the pagination navigation button is disabled",
            },
            {
              key: "paginationButtonDisabledBackgroundColor",
              label: "Background Color",
              type: "color",
              description: "The background color when the pagination navigation button is disabled",
            },
          ],
        },
      ],
    },
    {
      label: "Dialog",
      description: "Dialog variables",
      groups: [
        {
          label: "Overlay",
          description: "Dialog overlay background",
          tokens: [
            {
              key: "dialogSemiTransparentBackgroundColor",
              label: "Semi Transparent Background Color",
              type: "color",
              description:
                "The semi-transparent background color of the dialog overlay",
            },
            {
              key: "dialogSemiTransparentBackgroundOpacity",
              label: "Semi Transparent Background Opacity",
              type: "numeric",
              params: { step: "1", unit: "%", min: "0", max: "100" },
              description: "The opacity of the dialog overlay background",
            },
          ],
        },
        {
          label: "Content",
          description: "Dialog content layout and colors",
          tokens: [
            {
              key: "dialogSolidBackgroundColor",
              label: "Solid Background Color",
              type: "color",
              description: "The solid background color of the dialog",
            },
            {
              key: "dialogContentPaddingHorizontal",
              label: "Content Padding Horizontal",
              type: "size",
              description: "The horizontal padding of the dialog content",
            },
            {
              key: "dialogContentPaddingVertical",
              label: "Content Padding Vertical",
              type: "size",
              description: "The vertical padding of the dialog content",
            },
            {
              key: "dialogContentBorderRadius",
              label: "Content Border Radius",
              type: "size",
              description: "The border radius of the dialog content",
            },
            {
              key: "dialogContentBackgroundColor",
              label: "Content Background Color",
              type: "color",
              description: "The background color of the dialog content",
            },
          ],
        },
      ],
    },
    {
      label: "MultiSelect",
      description: "MultiSelect chip variables",
      groups: [
        {
          label: "Chip",
          description: "Chip layout and appearance",
          tokens: [
            {
              key: "chipBackground",
              label: "Background",
              type: "color",
              description: "The background color of the chip",
            },
            {
              key: "chipBorderRadius",
              label: "Border Radius",
              type: "size",
              description: "The border radius of the chip",
            },
            {
              key: "chipVerticalPadding",
              label: "Vertical Padding",
              type: "size",
              description: "The vertical padding of the chip",
            },
            {
              key: "chipHorizontalPadding",
              label: "Horizontal Padding",
              type: "size",
              description: "The horizontal padding of the chip",
            },
            {
              key: "chipGap",
              label: "Gap",
              type: "size",
              description: "The gap between chips text and icon",
            },
          ],
        },
      ],
    },
    {
      label: "Scrollbar",
      description: "Scrollbar variables",
      groups: [
        {
          label: "Scrollbar",
          description: "Scrollbar variables",
          tokens: [
            {
              key: "scrollbarBorderRadius",
              label: "Border Radius",
              type: "size",
              description: "The border radius of the scrollbar",
            },
            {
              key: "scrollbarTrackColor",
              label: "Track Color",
              type: "color",
              description: "The color of the scrollbar track",
            },
            {
              key: "scrollbarThumbColor",
              label: "Thumb Color",
              type: "color",
              description: "The color of the scrollbar thumb",
            },
          ],
        },
      ],
    },
  ],
};
