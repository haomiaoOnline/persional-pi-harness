import { existsSync, readFileSync } from "node:fs";

const [action, target] = process.argv.slice(2);
const expected = {
	"write-markdown": "# verified local artifact\n",
	"write-json": '{"status":"verified","source":"local-process"}\n',
	"write-report": "report: independently verified\n",
}[action];

if (!expected || !target || !existsSync(target) || readFileSync(target, "utf8") !== expected) {
	console.error(JSON.stringify({ action, target, verified: false }));
	process.exit(1);
}

process.stdout.write(JSON.stringify({ action, target, verified: true }));
