// Generates scripts/sample-paper.pdf — a minimal one-page paper whose first
// line is the title, so the pipeline's guessedTitle heuristic picks it up.
// Run: node scripts/make-sample-pdf.mjs
import { writeFileSync } from "node:fs";
import { PDFDocument, StandardFonts } from "pdf-lib";

const doc = await PDFDocument.create();
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
const regular = await doc.embedFont(StandardFonts.Helvetica);
const page = doc.addPage([612, 792]);

let y = 720;
page.drawText("Attention Is All You Need", { x: 60, y, size: 18, font: bold });
y -= 30;

const abstract =
  "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. The best performing models also connect the encoder and decoder through an attention mechanism. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely. Experiments on two machine translation tasks show these models to be superior in quality while being more parallelizable and requiring significantly less time to train.";

let line = "";
for (const word of abstract.split(" ")) {
  const test = line ? `${line} ${word}` : word;
  if (regular.widthOfTextAtSize(test, 11) > 492) {
    page.drawText(line, { x: 60, y, size: 11, font: regular });
    y -= 16;
    line = word;
  } else {
    line = test;
  }
}
if (line) page.drawText(line, { x: 60, y, size: 11, font: regular });

const bytes = await doc.save();
writeFileSync(new URL("./sample-paper.pdf", import.meta.url), bytes);
console.log(`wrote scripts/sample-paper.pdf (${bytes.length} bytes)`);
