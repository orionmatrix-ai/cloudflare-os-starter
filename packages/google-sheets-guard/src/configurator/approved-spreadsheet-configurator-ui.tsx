import {
  Field,
  h,
  Section,
  TextInput,
  type ConfiguratorUISpec,
} from "@gadgets/configurator-ui";
import type {
  ApprovedSpreadsheetConfiguratorRpc,
  ApprovedSpreadsheetConfiguratorValues,
} from "./approved-spreadsheet-configurator-types";

function canonicalSpreadsheetUrl(input: string | null | undefined): string | null {
  if (!input?.trim()) return null;
  try {
    const parsed = new URL(input.trim());
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (parsed.protocol !== "https:" || parsed.hostname !== "docs.google.com" ||
        segments.length < 4 || segments[0] !== "spreadsheets" ||
        segments[1] !== "d" || segments[3] !== "edit" || !segments[2]) {
      return null;
    }
    return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(segments[2])}/edit`;
  } catch {
    return null;
  }
}

export default {
  initial: { spreadsheetUrl: null },

  initialValuesFromResourceUrl({ resourceUrl }) {
    return { spreadsheetUrl: resourceUrl };
  },

  isReady({ values }) {
    return canonicalSpreadsheetUrl(values.spreadsheetUrl) !== null;
  },

  resourceUrl({ values }) {
    const canonicalUrl = canonicalSpreadsheetUrl(values.spreadsheetUrl);
    if (!canonicalUrl) throw new Error("Enter one valid Google Spreadsheet URL.");
    return canonicalUrl;
  },

  render({ values, setValues }) {
    return <Section>
      <Field
        label="Google Spreadsheet URL"
        description={
          "This form validates URL format only. The server separately requires an exact match " +
          "with the deployment-approved spreadsheet. Search, discovery, and range selection remain disabled."
        }>
        <TextInput
          name="spreadsheetUrl"
          value={values.spreadsheetUrl}
          placeholder="https://docs.google.com/spreadsheets/d/.../edit"
          onChange={spreadsheetUrl => setValues({ spreadsheetUrl })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<
  ApprovedSpreadsheetConfiguratorRpc,
  ApprovedSpreadsheetConfiguratorValues
>;
