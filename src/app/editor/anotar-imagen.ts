import {
  Component,
  ElementRef,
  HostListener,
  Injector,
  OnDestroy,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';

import {
  Caja,
  ENCAJE_ID,
  Encaje,
  Forma,
  Punto,
  TipoForma,
  COLOR_FONDO,
  almohadilla,
  caja,
  cajaFondo,
  componer,
  crearForma,
  crearTexto,
  dibujar,
  encajeDeGiro,
  esMinima,
  formaEn,
  grosorPara,
  invertir,
  medirTexto,
  mover,
  puntosCabeza,
  radioEsquina,
  recorteValido,
  rehacerTexto,
  tamTextoPara,
  transformar,
} from './formas';

/** Lo que hay que abrirle al diálogo: una URL local (blob:) de la imagen. */
export interface AnotarDatos {
  url: string;
  /** Extensión del original: decide el formato de salida (jpg se mantiene jpg). */
  ext: string;
  /**
   * Guarda la imagen. Se llama al aceptar y **antes de cerrar**, para que la
   * pantalla de carga tape también esta parte (escribir el fichero y meterlo en
   * la nota tarda lo suyo, y si no el usuario ve la app congelada).
   */
  guardar: (r: AnotarResultado) => Promise<void>;
}

/**
 * Qué hacer con la imagen al cerrar. `editada: false` = el usuario aceptó sin
 * tocar nada, así que se guarda el original tal cual (sin recomprimir).
 * `undefined` (diálogo cancelado) = no insertar nada.
 */
export type AnotarResultado =
  | { editada: false }
  | { editada: true; base64: string; ext: string };

/**
 * Herramienta activa: una forma, el recorte (que no dibuja nada), o `null`
 * cuando no hay ninguna armada y los clics solo sirven para seleccionar y
 * mover lo que ya está puesto.
 */
type Util = TipoForma | 'recorte' | null;

interface Herramienta {
  util: Util;
  icono: string;
  titulo: string;
  /** Deja un separador delante: el recorte no es una anotación más. */
  aparte?: boolean;
}

const HERRAMIENTAS: Herramienta[] = [
  { util: 'rect', icono: 'crop_square', titulo: 'Rectángulo' },
  { util: 'circulo', icono: 'radio_button_unchecked', titulo: 'Círculo' },
  { util: 'linea', icono: 'remove', titulo: 'Línea' },
  { util: 'flecha', icono: 'arrow_forward', titulo: 'Flecha' },
  { util: 'texto', icono: 'text_fields', titulo: 'Texto' },
  { util: 'recorte', icono: 'crop_rotate', titulo: 'Recortar y girar', aparte: true },
];

const COLORES = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ffffff', '#111111'];

/** Cuerpos de letra, como múltiplos del que corresponde a la imagen. */
const TAMANOS = [
  { mult: 0.65, etiqueta: 'A', titulo: 'Letra pequeña' },
  { mult: 1, etiqueta: 'A', titulo: 'Letra mediana' },
  { mult: 1.5, etiqueta: 'A', titulo: 'Letra grande' },
  { mult: 2.1, etiqueta: 'A', titulo: 'Letra muy grande' },
];

/** Margen de agarre, en píxeles de PANTALLA (se convierte a los de la imagen). */
const AGARRE = 10;

/** Pasos de deshacer que se recuerdan. */
const HISTORIA_MAX = 40;

/**
 * Lo que se ve la pantalla de carga como mínimo. Si el guardado tarda más,
 * sigue hasta que termine; el mínimo es para que no dé un parpadeo cuando va
 * rápido, que se lee como un fallo.
 */
const CARGA_MINIMA = 400;

/** Todo lo que hay que restaurar al deshacer un paso. */
interface Estado {
  formas: Forma[];
  url: string;
  ancho: number;
  alto: number;
  encaje: Encaje;
}

/**
 * Pantalla de edición de imagen, al estilo de la de WhatsApp: la imagen a
 * pantalla completa y encima se colocan formas (rectángulo, círculo, línea,
 * flecha y texto), además de poder recortarla.
 *
 * La vista previa es un SVG con `viewBox` del tamaño de la imagen, y al aceptar
 * se repinta lo mismo en un canvas de ese tamaño. Al compartir sistema de
 * coordenadas, lo exportado es exactamente lo que se vio.
 *
 * El recorte **rehace la imagen** (la recorta a un blob nuevo y desplaza las
 * anotaciones) en vez de guardarse como un estado aparte: así el resto del
 * componente sigue tratando con "una imagen y sus formas", sin más casos. Lo
 * que se pierde —volver atrás— lo cubre el historial de deshacer.
 */
@Component({
  selector: 'app-anotar-imagen',
  standalone: true,
  imports: [MatButtonModule],
  templateUrl: './anotar-imagen.html',
  styleUrl: './anotar-imagen.scss',
})
export class AnotarImagenDialog implements OnDestroy {
  protected readonly datos = inject<AnotarDatos>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<AnotarImagenDialog, AnotarResultado>>(MatDialogRef);
  private readonly inyector = inject(Injector);

  private readonly imgEl = viewChild.required<ElementRef<HTMLImageElement>>('img');
  private readonly marcoEl = viewChild.required<ElementRef<HTMLElement>>('marco');
  private readonly svgEl = viewChild<ElementRef<SVGSVGElement>>('lienzo');
  private readonly entradaEl = viewChild<ElementRef<HTMLInputElement>>('entrada');

  protected readonly herramientas = HERRAMIENTAS;
  protected readonly colores = COLORES;
  protected readonly tamanos = TAMANOS;

  /** Imagen que se está editando (cambia al recortar). */
  protected readonly url = signal('');
  /** Tamaño de esa imagen; 0 hasta que carga. */
  protected readonly ancho = signal(0);
  protected readonly alto = signal(0);

  protected readonly herramienta = signal<Util>('rect');
  protected readonly color = signal(COLORES[0]);

  /** Formas ya confirmadas. */
  protected readonly formas = signal<Forma[]>([]);
  /** La que se está dibujando ahora mismo (aún sin confirmar). */
  private readonly borrador = signal<Forma | null>(null);
  /** Índice de la forma seleccionada, o -1. */
  protected readonly seleccionada = signal(-1);
  /** El puntero está encima de una forma (para cambiar el cursor). */
  protected readonly sobreForma = signal(false);
  /** Rectángulo de recorte mientras se arrastra. */
  protected readonly recorte = signal<Caja | null>(null);
  /** Cajetín de texto abierto: dónde va y qué está editando. */
  protected readonly escribiendo = signal<{
    /** Esquina superior izquierda del texto, en coordenadas de la imagen. */
    en: Punto;
    /** Índice de la forma que se está reeditando, o -1 si es texto nuevo. */
    indice: number;
    valor: string;
  } | null>(null);

  /** Lo que hay escrito en el cajetín (para medir su ancho al vuelo). */
  private readonly textoEnCurso = signal('');
  /** Multiplicador del cuerpo de letra (los botones S/M/G/XG). */
  protected readonly tamElegido = signal(1);
  /** El texto nuevo llevará pastilla de fondo. */
  protected readonly conFondo = signal(false);

  /** Lo que se pinta: las confirmadas más, si la hay, la que se está trazando.
   *  El texto que se está reeditando se esconde: ya se ve en el cajetín. */
  protected readonly visibles = computed<Forma[]>(() => {
    const editando = this.escribiendo()?.indice ?? -1;
    const lista =
      editando >= 0 ? this.formas().filter((_, i) => i !== editando) : this.formas();
    const b = this.borrador();
    return b ? [...lista, b] : lista;
  });

  protected readonly hayHistoria = signal(false);
  /** Guardando: se tapa todo con la pantalla de carga. */
  protected readonly cargando = signal(false);

  // Estado del gesto en curso (no hace falta que sea reactivo).
  private modo: 'crear' | 'mover' | 'recortar' | null = null;
  private indice = -1;
  private inicio: Punto = { x: 0, y: 0 };
  private ultimo: Punto = { x: 0, y: 0 };
  private movido = false;

  private readonly historia: Estado[] = [];
  /** URLs que hemos creado nosotros (hay que soltarlas al cerrar). */
  private readonly urlsPropias: string[] = [];

  /** Cómo se llega de la imagen original a la actual (recortes y giros). */
  private encaje: Encaje = ENCAJE_ID;
  /** Tamaño de la imagen de partida, para poder restablecerla. */
  private original: { ancho: number; alto: number } | null = null;

  constructor() {
    this.url.set(this.datos.url);
  }

  ngOnDestroy(): void {
    // La URL de entrada la suelta quien abrió el diálogo; estas son nuestras.
    for (const u of this.urlsPropias) URL.revokeObjectURL(u);
  }

  /** Tamaño de la imagen ya conocido: hasta entonces no se puede dibujar. */
  protected alCargar(): void {
    const img = this.imgEl().nativeElement;
    this.ancho.set(img.naturalWidth);
    this.alto.set(img.naturalHeight);
    this.original ??= { ancho: img.naturalWidth, alto: img.naturalHeight };
  }

  /** ¿Se ha recortado o girado? (para habilitar "Restablecer"). */
  protected imagenTocada(): boolean {
    return this.url() !== this.datos.url;
  }

  protected get grosor(): number {
    return grosorPara(this.ancho(), this.alto());
  }

  protected get tamTexto(): number {
    return tamTextoPara(this.ancho(), this.alto());
  }

  /**
   * ¿Se muestran los controles de texto? Con la herramienta puesta, mientras se
   * escribe (al abrir el cajetín la herramienta se desarma) y también con un
   * texto seleccionado, para poder retocarle tamaño, color y fondo.
   */
  protected modoTexto(): boolean {
    return (
      this.herramienta() === 'texto' ||
      !!this.escribiendo() ||
      this.formas()[this.seleccionada()]?.tipo === 'texto'
    );
  }

  /** Al seleccionar algo, los controles pasan a reflejar lo que ese algo tiene. */
  private sincronizarControles(f: Forma | undefined): void {
    if (!f) return;
    this.color.set(f.color);
    if (f.tipo !== 'texto') return;
    this.conFondo.set(!!f.fondo);
    this.tamElegido.set(this.multiplicadorDe(f.tam ?? this.tamTexto));
  }

  // --- Historial ---

  /** Guarda el estado ANTES de cambiarlo. */
  private apuntar(): void {
    this.historia.push({
      formas: this.formas(),
      url: this.url(),
      ancho: this.ancho(),
      alto: this.alto(),
      encaje: this.encaje,
    });
    if (this.historia.length > HISTORIA_MAX) this.historia.shift();
    this.hayHistoria.set(true);
  }

  protected deshacer(): void {
    const previo = this.historia.pop();
    this.hayHistoria.set(this.historia.length > 0);
    if (!previo) return;
    this.formas.set(previo.formas);
    this.seleccionada.set(-1);
    this.encaje = previo.encaje;
    if (previo.url !== this.url()) {
      this.ancho.set(previo.ancho);
      this.alto.set(previo.alto);
      this.url.set(previo.url);
    }
  }

  // --- Ratón ---

  protected alPulsar(ev: MouseEvent): void {
    if (ev.button !== 0 || !this.ancho()) return;
    ev.preventDefault();
    if (this.escribiendo()) this.confirmarTexto(); // pulsar fuera cierra el cajetín

    const p = this.aImagen(ev);
    this.inicio = p;
    this.ultimo = p;
    this.movido = false;

    if (this.herramienta() === 'recorte') {
      this.modo = 'recortar';
      this.seleccionada.set(-1);
      this.recorte.set({ x: p.x, y: p.y, w: 0, h: 0 });
    } else {
      const i = formaEn(this.formas(), p, this.agarre());
      if (i >= 0) {
        // Sobre el trazo de una forma: se mueve.
        this.modo = 'mover';
        this.indice = i;
        this.seleccionada.set(i);
        this.sincronizarControles(this.formas()[i]);
        this.apuntar();
      } else if (this.herramienta() === 'texto' || !this.herramienta()) {
        /* Con la herramienta de texto el cajetín lo abre `alClic`, cuando el
           gesto ya ha terminado. Sin herramienta no hay nada que dibujar: el
           clic en zona libre solo deselecciona. */
        this.seleccionada.set(-1);
        return;
      } else {
        this.modo = 'crear';
        this.seleccionada.set(-1);
        this.borrador.set(crearForma(this.herramienta() as TipoForma, p, p, this.color(), this.grosor));
      }
    }

    /* Los listeners van en `document` y no en el SVG para que el gesto siga
       vivo aunque el puntero se salga de la imagen (el mismo enfoque que el
       arrastre de bloques del editor). */
    document.addEventListener('mousemove', this.alArrastrar);
    document.addEventListener('mouseup', this.alSoltar);
  }

  /** Con la herramienta de texto, un clic en zona libre abre el cajetín. */
  protected alClic(ev: MouseEvent): void {
    if (this.herramienta() !== 'texto' || !this.ancho() || this.escribiendo()) return;
    const p = this.aImagen(ev);
    if (formaEn(this.formas(), p, this.agarre()) >= 0) return; // era un clic sobre una forma
    this.abrirTexto(p, -1);
  }

  /** Doble clic sobre un texto: volver a editarlo. */
  protected alDobleClic(ev: MouseEvent): void {
    if (!this.ancho()) return;
    const i = formaEn(this.formas(), this.aImagen(ev), this.agarre());
    const f = this.formas()[i];
    if (f?.tipo !== 'texto') return;
    ev.preventDefault();
    this.seleccionada.set(-1);
    this.sincronizarControles(f);
    const c = caja(f);
    this.abrirTexto({ x: c.x, y: c.y }, i, f.texto ?? '');
  }

  /** Multiplicador de la lista que más se acerca a un cuerpo de letra dado. */
  private multiplicadorDe(tam: number): number {
    const base = this.tamTexto || 1;
    return TAMANOS.reduce((mejor, t) =>
      Math.abs(t.mult - tam / base) < Math.abs(mejor.mult - tam / base) ? t : mejor,
    ).mult;
  }

  /** Sin botón pulsado: solo decide la forma del cursor. */
  protected alPasar(ev: MouseEvent): void {
    if (this.modo || !this.ancho() || this.herramienta() === 'recorte') {
      this.sobreForma.set(false);
      return;
    }
    this.sobreForma.set(formaEn(this.formas(), this.aImagen(ev), this.agarre()) >= 0);
  }

  private readonly alArrastrar = (ev: MouseEvent): void => {
    const p = this.aImagen(ev);
    this.movido = true;
    if (this.modo === 'crear') {
      this.borrador.update((f) => (f ? { ...f, x2: p.x, y2: p.y } : f));
    } else if (this.modo === 'mover') {
      const dx = p.x - this.ultimo.x;
      const dy = p.y - this.ultimo.y;
      this.formas.update((lista) =>
        lista.map((f, i) => (i === this.indice ? mover(f, dx, dy) : f)),
      );
    } else if (this.modo === 'recortar') {
      this.recorte.set({
        x: Math.min(this.inicio.x, p.x),
        y: Math.min(this.inicio.y, p.y),
        w: Math.abs(p.x - this.inicio.x),
        h: Math.abs(p.y - this.inicio.y),
      });
    }
    this.ultimo = p;
  };

  private readonly alSoltar = (): void => {
    document.removeEventListener('mousemove', this.alArrastrar);
    document.removeEventListener('mouseup', this.alSoltar);

    if (this.modo === 'crear') {
      const f = this.borrador();
      this.borrador.set(null);
      /* Un clic suelto no crea nada: solo deselecciona. Al soltar, la forma
         recién dibujada queda SELECCIONADA (como en cualquier editor): así se
         puede borrarla, recolorearla o moverla al momento. Como contrapartida,
         elegir un color entonces la repinta a ella en vez de preparar el de la
         siguiente — que es lo esperable teniendo algo seleccionado, y el marco
         morado lo deja a la vista. Para empezar de cero: clic en zona libre. */
      if (f && !esMinima(f)) {
        this.apuntar();
        this.formas.update((lista) => [...lista, f]);
        this.seleccionada.set(this.formas().length - 1);
      }
    } else if (this.modo === 'mover') {
      // Un clic que no llegó a mover no merece un paso de deshacer.
      if (!this.movido) {
        this.historia.pop();
        this.hayHistoria.set(this.historia.length > 0);
      }
    } else if (this.modo === 'recortar') {
      const c = this.recorte();
      this.recorte.set(null);
      if (c && recorteValido(c)) void this.recortar(c);
    }
    this.modo = null;
  };

  /** Punto del ratón en coordenadas de la imagen, recortado a ella. */
  private aImagen(ev: MouseEvent): Punto {
    const svg = this.svgEl()?.nativeElement;
    if (!svg) return { x: 0, y: 0 };
    const r = svg.getBoundingClientRect();
    const x = ((ev.clientX - r.left) * this.ancho()) / (r.width || 1);
    const y = ((ev.clientY - r.top) * this.alto()) / (r.height || 1);
    return {
      x: Math.min(Math.max(x, 0), this.ancho()),
      y: Math.min(Math.max(y, 0), this.alto()),
    };
  }

  /** Píxeles de pantalla por píxel de imagen (la imagen se ve reducida). */
  private escala(): number {
    const r = this.svgEl()?.nativeElement.getBoundingClientRect();
    return r && r.width && this.ancho() ? r.width / this.ancho() : 1;
  }

  /** AGARRE está en píxeles de pantalla; aquí se pasa a los de la imagen. */
  private agarre(): number {
    return AGARRE / this.escala();
  }

  // --- Texto ---

  /** Cuerpo de letra que se aplicará: el de la imagen por el multiplicador. */
  protected tamActual(): number {
    return Math.max(10, Math.round(this.tamTexto * this.tamElegido()));
  }

  /**
   * Abre el cajetín de escritura. `indice` es la forma que se reedita (doble
   * clic) o -1 si el texto es nuevo.
   *
   * El foco se pide con `afterNextRender` y NO con un `setTimeout`: la app usa
   * `provideZoneChangeDetection({ eventCoalescing: true })`, que aplaza la
   * detección de cambios al siguiente frame, así que un temporizador a 0 se
   * ejecuta ANTES de que exista el `<input>` — el foco no se llegaba a poner y
   * había que volver a pulsar dentro del cajetín para poder escribir.
   */
  private abrirTexto(en: Punto, indice: number, valor = ''): void {
    this.escribiendo.set({ en, indice, valor });
    this.textoEnCurso.set(valor);
    /* La herramienta se desarma en cuanto hay un cajetín abierto: si siguiera
       activa, el clic con el que se cierra abriría otro cuadro detrás. Para
       escribir otro texto se vuelve a pulsar el botón. */
    this.herramienta.set(null);
    afterNextRender(
      () => {
        const el = this.entradaEl()?.nativeElement;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      },
      { injector: this.inyector },
    );
  }

  protected confirmarTexto(): void {
    const donde = this.escribiendo();
    if (!donde) return;
    const texto = (this.entradaEl()?.nativeElement.value ?? '').trim();
    this.escribiendo.set(null);

    // Texto nuevo: si se dejó en blanco, no se crea nada.
    if (donde.indice < 0) {
      if (!texto) return;
      this.apuntar();
      this.formas.update((lista) => [
        ...lista,
        crearTexto(donde.en, texto, this.tamActual(), this.color(), this.conFondo()),
      ]);
      return;
    }

    // Reedición: se sustituye en su sitio, o se borra si se vació.
    if (!this.formas()[donde.indice]) return;
    this.apuntar();
    const nueva = crearTexto(donde.en, texto, this.tamActual(), this.color(), this.conFondo());
    this.formas.update((lista) =>
      texto
        ? lista.map((f, i) => (i === donde.indice ? nueva : f))
        : lista.filter((_, i) => i !== donde.indice),
    );
  }

  protected cancelarTexto(): void {
    this.escribiendo.set(null);
  }

  /** Cambia el cuerpo de letra; si hay un texto seleccionado, también el suyo. */
  protected elegirTam(mult: number): void {
    this.tamElegido.set(mult);
    this.retocarTextoSeleccionado((f) => rehacerTexto(f, { tam: this.tamActual() }));
  }

  /** Pastilla de fondo: con o sin. */
  protected alternarFondo(valor: boolean): void {
    this.conFondo.set(valor);
    this.retocarTextoSeleccionado((f) => ({ ...f, fondo: valor }));
  }

  private retocarTextoSeleccionado(cambio: (f: Forma) => Forma): void {
    const i = this.seleccionada();
    const f = this.formas()[i];
    if (f?.tipo !== 'texto') return;
    this.apuntar();
    this.formas.update((lista) => lista.map((x, j) => (j === i ? cambio(x) : x)));
  }

  /** El cajetín se ciñe a lo escrito, midiéndolo igual que el render final. */
  protected alEscribir(ev: Event): void {
    this.textoEnCurso.set((ev.target as HTMLInputElement).value);
  }

  // Posición y medidas del cajetín, en píxeles de PANTALLA. El texto tiene que
  // caer donde caerá luego, así que se descuenta la almohadilla del padding.
  protected cajetin(): {
    izq: number;
    arr: number;
    tam: number;
    pad: string;
    ancho: number;
  } | null {
    const e = this.escribiendo();
    if (!e) return null;
    const escala = this.escala();
    const tam = this.tamActual() * escala;
    const p = almohadilla(tam);
    // Se mide aquí (y no al teclear) para que cambiar el cuerpo de letra a
    // media escritura reajuste el cajetín solo.
    const texto = medirTexto(this.textoEnCurso() || 'Escribe…', this.tamActual());
    return {
      izq: e.en.x * escala - p.x,
      arr: e.en.y * escala - p.y,
      tam,
      pad: `${p.y}px ${p.x}px`,
      // Un pelo de más para que el cursor quepa al final de la última letra.
      ancho: texto.ancho * escala + p.x * 2 + tam * 0.15,
    };
  }

  // --- Recortar y girar ---

  /**
   * Cambia la imagen por la del lienzo y lleva las anotaciones con ella,
   * aplicándoles la misma transformación (`op`) que se le hizo a la imagen.
   */
  private async rehacerImagen(lienzo: HTMLCanvasElement, op: Encaje): Promise<void> {
    // PNG siempre: es un paso intermedio y no debe perder calidad; el formato
    // final se decide al exportar.
    const blob = await new Promise<Blob | null>((r) => lienzo.toBlob(r, 'image/png'));
    if (!blob) return;

    this.apuntar();
    const url = URL.createObjectURL(blob);
    this.urlsPropias.push(url);
    this.formas.update((lista) => lista.map((f) => transformar(f, op)));
    this.encaje = componer(this.encaje, op.k, { x: op.tx, y: op.ty });
    this.ancho.set(lienzo.width);
    this.alto.set(lienzo.height);
    this.url.set(url);
    this.seleccionada.set(-1);
  }

  private async recortar(c: Caja): Promise<void> {
    const lienzo = document.createElement('canvas');
    lienzo.width = Math.round(c.w);
    lienzo.height = Math.round(c.h);
    const ctx = lienzo.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(
      this.imgEl().nativeElement,
      c.x, c.y, c.w, c.h,
      0, 0, lienzo.width, lienzo.height,
    );
    await this.rehacerImagen(lienzo, { k: 0, tx: -c.x, ty: -c.y });
  }

  /** Gira un cuarto de vuelta: `1` a la derecha, `-1` a la izquierda. */
  protected async girar(sentido: 1 | -1): Promise<void> {
    if (!this.ancho()) return;
    const ancho = this.ancho();
    const alto = this.alto();
    const lienzo = document.createElement('canvas');
    // Al girar 90° la imagen intercambia lados.
    lienzo.width = alto;
    lienzo.height = ancho;
    const ctx = lienzo.getContext('2d');
    if (!ctx) return;
    if (sentido === 1) {
      ctx.translate(alto, 0);
      ctx.rotate(Math.PI / 2);
    } else {
      ctx.translate(0, ancho);
      ctx.rotate(-Math.PI / 2);
    }
    ctx.drawImage(this.imgEl().nativeElement, 0, 0);
    await this.rehacerImagen(lienzo, encajeDeGiro(sentido, ancho, alto));
  }

  /**
   * Vuelve a la imagen de partida. Las anotaciones NO se pierden: se llevan de
   * vuelta con el encaje invertido, así que las hechas después de recortar o
   * girar acaban donde les toca sobre la imagen entera.
   */
  protected restablecer(): void {
    if (!this.imagenTocada() || !this.original) return;
    this.apuntar();
    const vuelta = invertir(this.encaje);
    this.formas.update((lista) => lista.map((f) => transformar(f, vuelta)));
    this.encaje = ENCAJE_ID;
    this.ancho.set(this.original.ancho);
    this.alto.set(this.original.alto);
    this.url.set(this.datos.url);
    this.seleccionada.set(-1);
  }

  // --- Acciones ---

  protected elegirHerramienta(util: Util): void {
    this.herramienta.set(util);
    if (util !== 'texto') this.confirmarTexto();
  }

  protected elegirColor(c: string): void {
    this.color.set(c);
    // Con una forma seleccionada, el color se le aplica a ella.
    const i = this.seleccionada();
    if (i >= 0) {
      this.apuntar();
      this.formas.update((lista) => lista.map((f, j) => (j === i ? { ...f, color: c } : f)));
    }
  }

  protected borrarSeleccionada(): void {
    const i = this.seleccionada();
    if (i < 0) return;
    this.apuntar();
    this.formas.update((lista) => lista.filter((_, j) => j !== i));
    this.seleccionada.set(-1);
  }

  @HostListener('document:keydown', ['$event'])
  protected alTeclear(ev: KeyboardEvent): void {
    // Escribiendo un texto mandan las teclas del cajetín, no estos atajos.
    if (ev.target instanceof HTMLInputElement || this.cargando()) return;

    if (ev.key === 'Escape') {
      // Escape suelta la selección antes que cerrar: así no se pierde el
      // trabajo por un despiste (el diálogo va con disableClose).
      if (this.seleccionada() >= 0) this.seleccionada.set(-1);
      else this.cancelar();
    } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
      if (this.seleccionada() >= 0) {
        ev.preventDefault();
        this.borrarSeleccionada();
      }
    } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      this.deshacer();
    }
  }

  protected cancelar(): void {
    if (this.cargando()) return;
    this.ref.close(undefined);
  }

  protected async aceptar(): Promise<void> {
    if (this.cargando()) return; // ya se está guardando: ni doble clic ni prisas
    this.confirmarTexto();
    this.cargando.set(true);
    const desde = Date.now();

    try {
      // Que la pantalla de carga LLEGUE A PINTARSE: lo que viene después
      // (toDataURL de la imagen entera) bloquea el hilo, y si no se cede el
      // turno antes, el usuario no vería nada hasta que terminara.
      await this.pintado();

      // Un recorte reciente puede no haber terminado de cargar en el <img>.
      const img = this.imgEl().nativeElement;
      if (!img.complete) {
        await new Promise<void>((listo) => {
          img.addEventListener('load', () => listo(), { once: true });
          img.addEventListener('error', () => listo(), { once: true });
        });
      }

      /* Sin formas y con la imagen de partida (puede haberse recortado y luego
         deshecho), sale intacta: ni se recompone ni se recomprime. */
      const res: AnotarResultado =
        !this.formas().length && this.url() === this.datos.url
          ? { editada: false }
          : this.exportar();

      await this.datos.guardar(res);
      await this.esperarMinimo(desde);
      this.ref.close(res);
    } catch (e) {
      console.error('No se pudo guardar la imagen editada:', e);
      this.cargando.set(false);
    }
  }

  /** Espera a que el navegador haya pintado (dos fotogramas: el primero corre
   *  antes de pintar, el segundo ya con lo anterior en pantalla). */
  private pintado(): Promise<void> {
    return new Promise((listo) =>
      requestAnimationFrame(() => requestAnimationFrame(() => listo())),
    );
  }

  private esperarMinimo(desde: number): Promise<void> {
    const falta = CARGA_MINIMA - (Date.now() - desde);
    return falta > 0 ? new Promise((r) => setTimeout(r, falta)) : Promise.resolve();
  }

  /** Repinta imagen + formas en un canvas del tamaño actual y lo exporta. */
  private exportar(): AnotarResultado {
    const lienzo = document.createElement('canvas');
    lienzo.width = this.ancho();
    lienzo.height = this.alto();
    const ctx = lienzo.getContext('2d');
    if (!ctx) throw new Error('sin contexto 2d');

    ctx.drawImage(this.imgEl().nativeElement, 0, 0, lienzo.width, lienzo.height);
    for (const f of this.formas()) dibujar(ctx, f);

    // Un JPEG se mantiene JPEG (una foto en PNG se dispararía de tamaño); todo
    // lo demás sale en PNG, que es lo suyo para capturas y conserva el alfa.
    const jpeg = /^jpe?g$/.test(this.datos.ext);
    const url = lienzo.toDataURL(jpeg ? 'image/jpeg' : 'image/png', 0.92);
    return { editada: true, base64: url.slice(url.indexOf(',') + 1), ext: jpeg ? 'jpg' : 'png' };
  }

  // --- Ayudas para la plantilla ---

  protected caja(f: Forma): Caja {
    return caja(f);
  }

  protected radio(f: Forma): number {
    return radioEsquina(f);
  }

  /** Línea base del texto: se ancla por arriba, pero se dibuja desde la base. */
  protected base(f: Forma): number {
    return caja(f).y + medirTexto(f.texto ?? '', f.tam ?? 24).ascenso;
  }

  /** Pastilla de fondo del texto. */
  protected pastilla(f: Forma): Caja {
    return cajaFondo(f);
  }

  protected readonly colorFondo = COLOR_FONDO;

  /** Puntos de la cabeza de flecha en el formato que espera <polyline>. */
  protected cabeza(f: Forma): string {
    return puntosCabeza(f)
      .map((p) => `${p.x},${p.y}`)
      .join(' ');
  }

  /**
   * Contorno del velo que oscurece lo que quedará fuera del recorte: el marco
   * entero menos el rectángulo elegido (regla par-impar).
   */
  protected velo(): string {
    const c = this.recorte();
    if (!c) return '';
    const W = this.ancho();
    const H = this.alto();
    return `M0 0H${W}V${H}H0Z M${c.x} ${c.y}H${c.x + c.w}V${c.y + c.h}H${c.x}Z`;
  }

  /** Caja punteada que marca la forma seleccionada (con algo de aire). */
  protected marcoSeleccion(): Caja | null {
    const f = this.formas()[this.seleccionada()];
    if (!f) return null;
    // En el texto se rodea la pastilla, que es lo que se ve.
    const c = f.tipo === 'texto' ? cajaFondo(f) : caja(f);
    const aire = f.tipo === 'texto' ? (f.tam ?? 24) * 0.14 : f.grosor * 2;
    return { x: c.x - aire, y: c.y - aire, w: c.w + aire * 2, h: c.h + aire * 2 };
  }
}
