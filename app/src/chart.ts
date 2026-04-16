import * as vega from "vega"
import * as vegaLite from "vega-lite"
import { Resvg } from "@resvg/resvg-js"
import type { SlackClient, SessionState } from "./types"

export type ExtractedChart = {
  spec: object
  title: string
  /** Raw data values from the spec's data.values, if present. */
  dataValues: Record<string, unknown>[] | null
}

/**
 * Extract `<vega-lite>...</vega-lite>` blocks from response text.
 * Tags are ALWAYS removed from the output text, even if the JSON is malformed.
 * Returns the cleaned text and an array of successfully parsed specs.
 */
export function extractVegaLiteSpecs(text: string): { cleanedText: string; charts: ExtractedChart[] } {
  const charts: ExtractedChart[] = []
  const cleanedText = text.replace(/<vega-lite>([\s\S]*?)<\/vega-lite>/g, (_match, specJson: string) => {
    try {
      const spec = JSON.parse(specJson.trim())
      const title = typeof spec.title === "string"
        ? spec.title
        : typeof spec.title?.text === "string"
          ? spec.title.text
          : "Chart"
      const dataValues = Array.isArray(spec.data?.values) ? spec.data.values : null
      charts.push({ spec, title, dataValues })
    } catch (e) {
      console.error("Failed to parse vega-lite spec (malformed JSON — tag still stripped from output):", e)
      return "\n\n_⚠ A chart was generated but could not be rendered (malformed JSON in the visualization spec)._\n\n"
    }
    return "" // remove the tag; chart will be rendered and uploaded
  })

  return { cleanedText: cleanedText.trim(), charts }
}

/**
 * Build a CSV string from an array of data objects.
 */
function buildCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return ""
  const keys = Object.keys(rows[0])
  const header = keys.map(escapeCsvField).join(",")
  const body = rows.map((row) =>
    keys.map((k) => escapeCsvField(String(row[k] ?? ""))).join(","),
  )
  return [header, ...body].join("\n")
}

function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

/**
 * Render a vega-lite spec to a PNG buffer.
 */
async function renderToPng(vlSpec: object, scale = 2): Promise<Buffer> {
  // Inject a font into the vega-lite config before compiling so all text
  // elements (axis labels, titles, tick labels) use Noto Sans — the only
  // font guaranteed to be present in the Docker container.
  const specWithFont = {
    ...vlSpec,
    config: {
      ...(vlSpec as any).config,
      font: "Noto Sans",
    },
  }

  const compiled = vegaLite.compile(specWithFont as vegaLite.TopLevelSpec)
  const view = new vega.View(vega.parse(compiled.spec), { renderer: "none" })
  const svg = await view.toSVG()
  view.finalize()
  const resvg = new Resvg(svg, {
    fitTo: { mode: "zoom", value: scale },
    font: {
      loadSystemFonts: false,
      fontDirs: ["/usr/share/fonts/truetype/noto"],
      defaultFontFamily: "Noto Sans",
    },
  })
  const rendered = resvg.render()
  return Buffer.from(rendered.asPng())
}

/**
 * Render vega-lite specs to PNG (and optionally CSV) and upload to the Slack thread.
 */
export async function renderAndUploadCharts(
  client: SlackClient,
  session: SessionState,
  charts: ExtractedChart[],
): Promise<void> {
  for (const chart of charts) {
    try {
      const pngBuffer = await renderToPng(chart.spec)
      const ts = Date.now()

      await client.files.uploadV2({
        channel_id: session.channel,
        thread_ts: session.thread,
        title: chart.title,
        filename: `chart-${ts}.png`,
        file: pngBuffer,
      })

      // Upload data as CSV alongside the chart when values are present
      if (chart.dataValues && chart.dataValues.length > 0) {
        const csv = buildCsv(chart.dataValues)
        await client.files.uploadV2({
          channel_id: session.channel,
          thread_ts: session.thread,
          title: `${chart.title} (data)`,
          filename: `chart-data-${ts}.csv`,
          filetype: "csv",
          content: csv,
        })
      }
    } catch (e) {
      console.error(`Failed to render/upload chart "${chart.title}":`, e)
    }
  }
}
