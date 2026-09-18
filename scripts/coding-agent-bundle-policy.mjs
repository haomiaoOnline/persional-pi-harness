import { isBuiltin } from "node:module";

export function validateBundleExternalImports(metafiles, allowedExternalPackages) {
	const unexpected = new Set();
	for (const metafile of metafiles) {
		for (const input of Object.values(metafile.inputs)) {
			for (const imported of input.imports) {
				if (!imported.external || isBuiltin(imported.path) || allowedExternalPackages.has(imported.path)) continue;
				unexpected.add(imported.path);
			}
		}
	}
	if (unexpected.size > 0) {
		throw new Error(`Bundle left unexpected external imports: ${Array.from(unexpected).sort().join(", ")}`);
	}
}

export function validateBundleRequiredOutputs(metafiles, requiredOutputs) {
	const outputs = new Set(
		metafiles.flatMap((metafile) => Object.keys(metafile.outputs).map((path) => path.replaceAll("\\", "/"))),
	);
	const missing = requiredOutputs
		.map((path) => path.replaceAll("\\", "/"))
		.filter((path) => !outputs.has(path) && !Array.from(outputs).some((output) => output.endsWith(`/${path}`)));
	if (missing.length > 0) {
		throw new Error(`Bundle did not emit required output(s): ${missing.sort().join(", ")}`);
	}
}
