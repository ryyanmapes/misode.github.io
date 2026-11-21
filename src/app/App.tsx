import type { RouterOnChangeArgs } from 'preact-router'
import { getCurrentUrl, Router } from 'preact-router'
import { useState } from 'preact/hooks'
import '../styles/global.css'
import '../styles/nodes.css'
import { Analytics } from './Analytics.js'
import { Header } from './components/index.js'
import { Changelog, Convert, Customized, Generator, Generators, Graph, Guide, Guides, Home, LegacyPartners, Partners, Sounds, Transformation, Versions, WhatsNew, Worldgen } from './pages/index.js'
import { cleanUrl } from './Utils.js'

export function App() {
	const [url, setUrl] = useState(getCurrentUrl())
	const changeRoute = (e: RouterOnChangeArgs) => {
		setUrl(e.url)
		window.dispatchEvent(new CustomEvent('replacestate'))
		// Needs a timeout to ensure the title is set correctly
		setTimeout(() => Analytics.pageview(cleanUrl(e.url)))
	}

	return <>
		{/* The graph editor fills the whole window and has its own app bar */}
		{!cleanUrl(url).startsWith('/graph/') && <Header />}
		<Router onChange={changeRoute}>
			<Home path="/" />
			<Generators path="/generators" />
			<Worldgen path="/worldgen" />
			<Partners path="/partners" />
			<LegacyPartners path="/partners/:id" />
			<Sounds path="/sounds" />
			<Changelog path="/changelog" />
			<Versions path="/versions" />
			<Transformation path="/transformation" />
			<Customized path="/customized" />
			<Convert path="/convert" />
			<Convert path="/convert/:formats" />
			<WhatsNew path="/whats-new" />
			<Guides path="/guides" />
			<Guide path="/guides/:id" />
			<Graph path="/graph/:demo?" />
			<Generator default />
		</Router>
	</>
}
