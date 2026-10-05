import type { LngLatBoundsLike, Map as MapLibreMap, MapOptions } from 'maplibre-gl';
import { i18n } from '../i18n';
import { openMap } from '../navigation';
import { icons } from '../styles/icons';
import { agentDeckTheme } from '../styles/theme';

type Position = [lng: number, lat: number];

/** Body of an `agentdeck-map` fenced block, as taught by the host's map skill. */
type MapData = {
  title?: string;
  markers?: { name?: string; description?: string; coordinates: Position }[];
  routes?: { name?: string; coordinates: Position[] }[];
};

const isPosition = (value: unknown): value is Position =>
  Array.isArray(value) && value.length >= 2 && value.every((n) => typeof n === 'number');

const parseMap = (source: string): MapData | undefined => {
  try {
    const data: MapData = JSON.parse(source);
    const markers = (data.markers || []).filter((marker) => isPosition(marker?.coordinates));
    const routes = (data.routes || []).filter(
      (route) => Array.isArray(route?.coordinates) && route.coordinates.filter(isPosition).length > 1,
    );
    if (markers.length || routes.length) return { title: data.title, markers, routes };
  } catch {}
};

const positionsOf = ({ markers = [], routes = [] }: MapData) => [
  ...markers.map(({ coordinates }) => coordinates),
  ...routes.flatMap(({ coordinates }) => coordinates.filter(isPosition)),
];

const boundsOf = (data: MapData): LngLatBoundsLike => {
  const positions = positionsOf(data);
  const lngs = positions.map(([lng]) => lng);
  const lats = positions.map(([, lat]) => lat);
  return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
};

/**
 * MapLibre ships as `/maplibre/` static files (see `rsbuild.config.ts`) and loads from there, so its worker shares the same
 * modules; the worker URL is set explicitly because MapLibre only derives it from `http(s)` module URLs, not `tauri://`.
 */
const MAPLIBRE_BASE = new URL('/maplibre/', location.href).href;

let maplibre: Promise<typeof import('maplibre-gl')> | undefined;
const loadMapLibre = () => {
  maplibre ||= import(/* webpackIgnore: true */ `${MAPLIBRE_BASE}maplibre-gl.mjs`).then((module) => {
    module.setWorkerUrl(`${MAPLIBRE_BASE}maplibre-gl-worker.mjs`);
    return module;
  });
  return maplibre;
};

const mapStyleUrl = `https://tiles.openfreemap.org/styles/${
  globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'positron'
}`;

const createMap = async (container: HTMLElement, data: MapData, options: Partial<MapOptions> = {}) => {
  const maplibregl = await loadMapLibre();
  const map = new maplibregl.Map({
    container,
    style: mapStyleUrl,
    bounds: boundsOf(data),
    fitBoundsOptions: { padding: 40, maxZoom: 15 },
    ...options,
  });
  // WebGL needs concrete colors; the container's `color` resolves the theme's `light-dark()`.
  const { color: accent, backgroundColor: halo } = getComputedStyle(container);
  map.on('load', () => addOverlay(map, data, accent, halo));
  return map;
};

const addOverlay = (map: MapLibreMap, { markers = [], routes = [] }: MapData, accent: string, halo: string) => {
  map.addSource('deck-routes', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: routes.map(({ name, coordinates }) => ({
        type: 'Feature',
        properties: { name },
        geometry: { type: 'LineString', coordinates: coordinates.filter(isPosition) },
      })),
    },
  });
  map.addSource('deck-markers', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: markers.map(({ name, description, coordinates }) => ({
        type: 'Feature',
        properties: { name, description },
        geometry: { type: 'Point', coordinates },
      })),
    },
  });
  const line = { 'line-cap': 'round', 'line-join': 'round' } as const;
  map.addLayer({
    id: 'deck-route-casing',
    type: 'line',
    source: 'deck-routes',
    layout: line,
    paint: { 'line-color': halo, 'line-width': 7 },
  });
  map.addLayer({
    id: 'deck-route',
    type: 'line',
    source: 'deck-routes',
    layout: line,
    paint: { 'line-color': accent, 'line-width': 4 },
  });
  map.addLayer({
    id: 'deck-marker',
    type: 'circle',
    source: 'deck-markers',
    paint: { 'circle-radius': 7, 'circle-color': accent, 'circle-stroke-width': 2, 'circle-stroke-color': halo },
  });
  map.addLayer({
    id: 'deck-marker-label',
    type: 'symbol',
    source: 'deck-markers',
    layout: {
      'text-field': ['coalesce', ['get', 'name'], ''],
      'text-font': ['Noto Sans Regular'],
      'text-size': 13,
      'text-variable-anchor': ['top', 'bottom', 'right', 'left'],
      'text-radial-offset': 0.8,
      'text-optional': true,
    },
    paint: { 'text-color': accent, 'text-halo-color': halo, 'text-halo-width': 1.5 },
  });
};

/** Card snapshots by source: each map would hold a WebGL context, so cards keep only an image. */
const snapshots = new Map<string, string>();

const cardStyle = css`
  :host {
    position: relative;
    display: block;
    box-sizing: border-box;
    overflow: hidden;
  }
  .card {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    width: 100%;
    height: 12rem;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;
  }
  .view {
    position: relative;
    flex: 1;
    height: 0;
  }
  .map {
    color: ${agentDeckTheme.primaryColor};
    background-color: ${agentDeckTheme.lightBackgroundColor};
  }
  .map,
  .shot {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .shot {
    object-fit: cover;
  }
  .placeholder {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    background: ${agentDeckTheme.lightBackgroundColor};
    color: ${agentDeckTheme.describeColor};
    font-size: ${agentDeckTheme.fontSizeXs};
  }
  .placeholder tap-use {
    width: 1.25rem;
  }
  .attribution {
    position: absolute;
    right: 0.25rem;
    bottom: 0.125rem;
    color: ${agentDeckTheme.describeColor};
    font-size: 10px;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem 0.75rem;
    border-top: ${agentDeckTheme.borderWidth} solid ${agentDeckTheme.borderColor};
    background: ${agentDeckTheme.lightBackgroundColor};
  }
  .bar tap-use {
    flex-shrink: 0;
    width: 1.5rem;
    color: ${agentDeckTheme.primaryColor};
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: ${agentDeckTheme.highlightColor};
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .open {
    flex-shrink: 0;
    color: ${agentDeckTheme.primaryStrongColor};
    font-size: ${agentDeckTheme.fontSizeXs};
    font-weight: 600;
  }
  pre {
    margin: 0;
    padding: 0.75rem;
    overflow: auto;
    font-family: ${agentDeckTheme.codeFont};
    font-size: ${agentDeckTheme.fontSizeXs};
  }
`;

const mapTitle = (data?: MapData) => data?.title || data?.markers?.[0]?.name || i18n.get('map.title');

@customElement('deck-map')
@adoptedStyle(cardStyle)
@shadow()
export class DeckMapElement extends GemElement {
  @attribute source: string;

  #mapRef = createRef<HTMLDivElement>();
  #state = createState({ shot: '', error: false });

  @memo((i) => [i.source])
  get #data() {
    return parseMap(this.source);
  }

  // Renders once the card scrolls into view, then keeps the frame and releases the map.
  @effect((i) => [i.source])
  #snapshot = () => {
    const data = this.#data;
    const cached = snapshots.get(this.source);
    this.#state({ shot: cached || '', error: false });
    if (!data || cached) return;
    let map: MapLibreMap | undefined;
    let disposed = false;
    const observer = new IntersectionObserver(async ([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      const container = this.#mapRef.value;
      if (!container) return;
      let instance: MapLibreMap;
      try {
        instance = await createMap(container, data, {
          interactive: false,
          attributionControl: false,
          canvasContextAttributes: { preserveDrawingBuffer: true },
        });
      } catch {
        return this.#state({ error: true });
      }
      if (disposed) return instance.remove();
      map = instance;
      instance.on('error', () => !instance.loaded() && this.#state({ error: true }));
      instance.once('load', () =>
        instance.once('idle', () => {
          const shot = instance.getCanvas().toDataURL('image/jpeg', 0.9);
          snapshots.set(this.source, shot);
          this.#state({ shot });
          instance.remove();
          map = undefined;
        }),
      );
    });
    observer.observe(this);
    return () => {
      disposed = true;
      observer.disconnect();
      map?.remove();
    };
  };

  @template()
  #render = () => {
    const data = this.#data;
    // Invalid JSON stays readable as the original block.
    if (!data) return html`<pre>${this.source}</pre>`;
    const { shot, error } = this.#state;
    return html`
      <link rel="stylesheet" href=${`${MAPLIBRE_BASE}maplibre-gl.css`} />
      <button class="card" type="button" @click=${() => openMap(this.source)}>
        <div class="view">
          <div v-if=${!shot} class="map" ${this.#mapRef}></div>
          <img v-else class="shot" src=${shot} alt="" />
          <div v-if=${!shot} class="placeholder">
            <tap-use v-if=${!error} .element=${icons.loading}></tap-use>
            ${error ? i18n.get('map.unavailable') : i18n.get('map.loading')}
          </div>
          <span v-if=${!!shot} class="attribution">© OpenStreetMap</span>
        </div>
        <div class="bar">
          <tap-use .element=${icons.mapPin}></tap-use>
          <div class="name">${mapTitle(data)}</div>
          <span class="open">${i18n.get('map.open')}</span>
        </div>
      </button>
    `;
  };
}

const pageStyle = css`
  :scope {
    height: 100%;
  }
  :scope .map {
    position: absolute;
    inset: 0;
    color: ${agentDeckTheme.primaryColor};
    background-color: ${agentDeckTheme.lightBackgroundColor};
  }
  :scope .maplibregl-popup-content {
    border-radius: ${agentDeckTheme.smallRound};
    background: ${agentDeckTheme.lightBackgroundColor};
    color: ${agentDeckTheme.textColor};
    font: inherit;
    font-size: ${agentDeckTheme.fontSizeSm};
  }
  :scope .maplibregl-popup-tip {
    display: none;
  }
  :scope .maplibregl-popup-content strong {
    color: ${agentDeckTheme.highlightColor};
  }
  :scope footer {
    height: var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px));
  }
`;

@customElement('deck-map-page')
@adoptedStyle(pageStyle)
export class DeckMapPageElement extends GemElement {
  @property source = '';

  #mapRef = createRef<HTMLDivElement>();
  #state = createState({ entered: false, loaded: false, error: '', revision: 0 });

  #retry = () => this.#state({ loaded: false, error: '', revision: this.#state.revision + 1 });

  @memo((i) => [i.source])
  get #data() {
    return parseMap(this.source);
  }

  // Building the map is heavy, so it waits until the enter animation completes.
  @effect((i) => [i.#state.entered, i.#state.revision])
  #create = () => {
    const data = this.#data;
    if (!this.#state.entered || !data) return;
    let map: MapLibreMap | undefined;
    let disposed = false;
    (async () => {
      const container = this.#mapRef.value;
      if (!container) return;
      const { Popup } = await loadMapLibre();
      const instance = await createMap(container, data, { attributionControl: { compact: true } });
      if (disposed) return instance.remove();
      map = instance;
      instance.on('error', ({ error }) => !instance.loaded() && this.#state({ error: error.message }));
      instance.once('load', () => this.#state({ loaded: true }));
      instance.on('click', 'deck-marker', ({ features, lngLat }) => {
        const { name = '', description = '' } = features?.[0]?.properties || {};
        if (!name && !description) return;
        const content = document.createElement('div');
        if (name) content.append(Object.assign(document.createElement('strong'), { textContent: name }));
        if (description) content.append(Object.assign(document.createElement('div'), { textContent: description }));
        new Popup({ closeButton: false }).setLngLat(lngLat).setDOMContent(content).addTo(instance);
      });
    })().catch((error) => this.#state({ error: String(error) }));
    return () => {
      disposed = true;
      map?.remove();
    };
  };

  @template()
  #render = () => {
    const { loaded, error } = this.#state;
    return html`
      <link rel="stylesheet" href=${`${MAPLIBRE_BASE}maplibre-gl.css`} />
      <tap-page class="bg-bg text-text" .trackVisibility=${false} @full-show=${() => this.#state({ entered: true })}>
        <tap-navbar slot="header" title=${mapTitle(this.#data)} back default-back></tap-navbar>
        <main class="relative h-full overflow-hidden">
          <div class="map" ${this.#mapRef}></div>
          <deck-loading
            v-if=${!loaded && !error}
            class="absolute inset-x-0 top-0"
            label=${i18n.get('map.loading')}
          ></deck-loading>
          <deck-error
            v-if=${!!error}
            class="absolute inset-x-0 top-0"
            heading=${i18n.get('map.unavailable')}
            error=${error}
            @retry=${this.#retry}
          ></deck-error>
        </main>
        <footer slot="footer"></footer>
      </tap-page>
    `;
  };
}
