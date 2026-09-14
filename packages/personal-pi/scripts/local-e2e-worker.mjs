import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const [action, target] = process.argv.slice(2);
const content = {
	"write-markdown": "# verified local artifact\n",
	"write-json": '{"status":"verified","source":"local-process"}\n',
	"write-report": "report: independently verified\n",
}[action];

if (!content || !target) {
	console.error("invalid local worker arguments");
	process.exit(2);
}

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, content, "utf8");
process.stdout.write(JSON.stringify({ action, target, bytes: Buffer.byteLength(content) }));
