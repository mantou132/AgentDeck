const style = css`
  :scope {
    position: relative;
    display: block;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: 24px;
    background: #000;
  }
  a {
    position: absolute;
    inset: 0;
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  a::after {
    content: "";
    position: absolute;
    top: 50%;
    left: 50%;
    width: 84px;
    height: 84px;
    border-radius: 50%;
    background:
      rgb(14 17 51 / 0.75)
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='white'%3E%3Cpath d='M8 5v14l11-7z'/%3E%3C/svg%3E")
      center / 40px no-repeat;
    transform: translate(-50%, -50%);
    backdrop-filter: blur(6px);
    transition: transform 0.15s;
  }
  a:hover::after {
    transform: translate(-50%, -50%) scale(1.08);
  }
  iframe {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border: 0;
  }
`;

/** YouTube video that loads the player only after a click */
@customElement('app-video')
@adoptedStyle(style)
export class AppVideoElement extends GemElement {
  @attribute videoId: string;

  #state = createState({ playing: false });

  #play = (evt: MouseEvent) => {
    evt.preventDefault();
    this.#state({ playing: true });
  };

  @template()
  #content = () => html`
    <iframe
      v-if=${this.#state.playing}
      src="https://www.youtube-nocookie.com/embed/${this.videoId}?autoplay=1"
      allow="autoplay; encrypted-media; picture-in-picture"
      allowfullscreen
    ></iframe>
    <a
      v-else
      href="https://www.youtube.com/watch?v=${this.videoId}"
      aria-label=${i18n.get('playVideo')}
      @click=${this.#play}
    >
      <img src="https://img.youtube.com/vi/${this.videoId}/maxresdefault.jpg" alt="" />
    </a>
  `;
}
