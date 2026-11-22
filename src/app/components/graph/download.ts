/** Offers something as a file to save */
export function saveFile(name: string, contents: Blob) {
	const url = URL.createObjectURL(contents)
	const link = document.createElement('a')
	link.href = url
	link.download = name
	document.body.appendChild(link)
	link.click()
	link.remove()
	// The browser has started saving by now
	setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Offers JSON as a file to save, written the way the files of a data pack are */
export function saveJson(name: string, json: unknown) {
	saveFile(name, new Blob([`${JSON.stringify(json, null, 2)}\n`], { type: 'application/json' }))
}

/** The name of the file that something with an id is in a data pack, without its folders */
export function fileNameOf(id: string, extension: string) {
	const path = id.slice(id.indexOf(':') + 1)
	return path.slice(path.lastIndexOf('/') + 1) + extension
}
