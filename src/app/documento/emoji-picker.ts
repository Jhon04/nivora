import {
  AfterViewInit,
  Component,
  computed,
  ElementRef,
  HostListener,
  output,
  signal,
  ViewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { normalizar } from '../core/texto';

/** Un emoji con sus palabras clave (para el buscador). */
interface Emoji {
  e: string;
  k: string;
}

interface Categoria {
  id: string;
  etiqueta: string;
  emojis: Emoji[];
}

/** Set curado de emojis por categoría, con palabras clave en español. */
const CATEGORIAS: Categoria[] = [
  {
    id: 'caras',
    etiqueta: '😀',
    emojis: [
      { e: '😀', k: 'cara sonrisa feliz alegre' },
      { e: '😃', k: 'cara sonrisa feliz boca abierta' },
      { e: '😄', k: 'cara sonrisa feliz ojos alegre' },
      { e: '😁', k: 'cara sonrisa dientes feliz' },
      { e: '😆', k: 'risa carcajada' },
      { e: '😅', k: 'risa sudor nervioso' },
      { e: '😂', k: 'risa llorar lagrimas' },
      { e: '🤣', k: 'risa suelo carcajada' },
      { e: '🙂', k: 'sonrisa leve' },
      { e: '🙃', k: 'al reves boca abajo' },
      { e: '😉', k: 'guiño' },
      { e: '😊', k: 'sonrojo feliz timido' },
      { e: '😇', k: 'angel santo aureola' },
      { e: '🥰', k: 'amor corazones enamorado' },
      { e: '😍', k: 'amor ojos corazon enamorado' },
      { e: '🤩', k: 'estrellas asombro flipar' },
      { e: '😘', k: 'beso' },
      { e: '😋', k: 'rico delicioso sabroso lengua' },
      { e: '😛', k: 'lengua burla' },
      { e: '😜', k: 'guiño lengua' },
      { e: '🤪', k: 'loco chiflado' },
      { e: '😝', k: 'lengua ojos cerrados' },
      { e: '🤗', k: 'abrazo' },
      { e: '🤭', k: 'risa tapar boca ups' },
      { e: '🤫', k: 'silencio callar shh' },
      { e: '🤔', k: 'pensar duda' },
      { e: '🤨', k: 'ceja duda escepticismo' },
      { e: '😐', k: 'neutral serio' },
      { e: '😑', k: 'inexpresivo sin gracia' },
      { e: '😶', k: 'sin boca callado' },
      { e: '😏', k: 'picaro presumido' },
      { e: '😒', k: 'fastidio molesto' },
      { e: '🙄', k: 'ojos en blanco' },
      { e: '😬', k: 'mueca incomodo' },
      { e: '😌', k: 'aliviado tranquilo' },
      { e: '😔', k: 'triste pena decepcion' },
      { e: '😴', k: 'dormir sueño zzz' },
      { e: '😷', k: 'mascarilla enfermo' },
      { e: '🤒', k: 'termometro fiebre enfermo' },
      { e: '🤕', k: 'herida venda golpe' },
      { e: '🥳', k: 'fiesta celebracion cumpleaños' },
      { e: '🥺', k: 'suplica ternura ojos' },
      { e: '😎', k: 'gafas sol guay cool' },
      { e: '🤓', k: 'nerd gafas empollon' },
      { e: '🧐', k: 'monoculo curioso inspeccionar' },
      { e: '😳', k: 'sonrojo verguenza sorpresa' },
      { e: '🥵', k: 'calor sofocado' },
      { e: '🥶', k: 'frio helado' },
    ],
  },
  {
    id: 'gestos',
    etiqueta: '👍',
    emojis: [
      { e: '👍', k: 'pulgar arriba bien ok me gusta' },
      { e: '👎', k: 'pulgar abajo mal no me gusta' },
      { e: '👌', k: 'ok perfecto genial' },
      { e: '✌️', k: 'paz victoria dos' },
      { e: '🤞', k: 'dedos cruzados suerte' },
      { e: '🤟', k: 'te quiero rock' },
      { e: '🤘', k: 'rock cuernos' },
      { e: '🤙', k: 'llamame' },
      { e: '👋', k: 'hola adios saludo mano' },
      { e: '🙌', k: 'manos arriba celebrar' },
      { e: '👏', k: 'aplausos aplaudir' },
      { e: '🙏', k: 'rezar gracias por favor' },
      { e: '💪', k: 'musculo fuerza biceps' },
      { e: '🫶', k: 'corazon manos amor' },
      { e: '🤝', k: 'apreton manos trato acuerdo' },
      { e: '👀', k: 'ojos mirar' },
      { e: '🧠', k: 'cerebro mente' },
      { e: '❤️', k: 'corazon amor rojo' },
      { e: '🔥', k: 'fuego llama' },
      { e: '⭐', k: 'estrella' },
      { e: '✨', k: 'brillos destellos magia' },
      { e: '💯', k: 'cien perfecto nota' },
      { e: '✅', k: 'check correcto ok visto bien' },
      { e: '❌', k: 'equis mal error incorrecto' },
      { e: '⚠️', k: 'advertencia precaucion cuidado' },
      { e: '❓', k: 'pregunta interrogacion duda' },
      { e: '❗', k: 'exclamacion importante' },
      { e: '💡', k: 'idea bombilla luz' },
      { e: '🎉', k: 'fiesta confeti celebracion' },
      { e: '🎊', k: 'confeti bola fiesta' },
      { e: '🚀', k: 'cohete espacio lanzar' },
      { e: '🏆', k: 'trofeo ganar premio' },
      { e: '🎯', k: 'diana objetivo meta' },
      { e: '🔑', k: 'llave clave' },
      { e: '🔒', k: 'candado bloqueo seguro' },
      { e: '📌', k: 'chincheta pin fijar' },
    ],
  },
  {
    id: 'animales',
    etiqueta: '🐶',
    emojis: [
      { e: '🐶', k: 'perro cachorro' },
      { e: '🐱', k: 'gato michi' },
      { e: '🐭', k: 'raton' },
      { e: '🐹', k: 'hamster' },
      { e: '🐰', k: 'conejo' },
      { e: '🦊', k: 'zorro' },
      { e: '🐻', k: 'oso' },
      { e: '🐼', k: 'panda' },
      { e: '🐨', k: 'koala' },
      { e: '🐯', k: 'tigre' },
      { e: '🦁', k: 'leon' },
      { e: '🐮', k: 'vaca' },
      { e: '🐷', k: 'cerdo' },
      { e: '🐸', k: 'rana' },
      { e: '🐵', k: 'mono' },
      { e: '🐔', k: 'gallina pollo' },
      { e: '🐧', k: 'pinguino' },
      { e: '🐦', k: 'pajaro ave' },
      { e: '🦄', k: 'unicornio' },
      { e: '🐝', k: 'abeja' },
      { e: '🦋', k: 'mariposa' },
      { e: '🐢', k: 'tortuga' },
      { e: '🐬', k: 'delfin' },
      { e: '🐳', k: 'ballena' },
      { e: '🌱', k: 'planta brote semilla' },
      { e: '🌲', k: 'arbol pino' },
      { e: '🌳', k: 'arbol' },
      { e: '🌴', k: 'palmera' },
      { e: '🌵', k: 'cactus' },
      { e: '🌿', k: 'hierba hoja' },
      { e: '🍀', k: 'trebol suerte' },
      { e: '🌸', k: 'flor cerezo' },
      { e: '🌼', k: 'flor margarita' },
      { e: '🌻', k: 'girasol flor' },
      { e: '🌹', k: 'rosa flor' },
      { e: '🌊', k: 'ola mar agua' },
      { e: '🌙', k: 'luna noche' },
      { e: '☀️', k: 'sol' },
      { e: '⚡', k: 'rayo electricidad' },
      { e: '❄️', k: 'copo nieve frio' },
      { e: '🌈', k: 'arcoiris' },
      { e: '🍄', k: 'seta hongo' },
    ],
  },
  {
    id: 'comida',
    etiqueta: '🍎',
    emojis: [
      { e: '🍎', k: 'manzana roja fruta' },
      { e: '🍊', k: 'naranja mandarina fruta' },
      { e: '🍋', k: 'limon fruta' },
      { e: '🍌', k: 'platano banana fruta' },
      { e: '🍉', k: 'sandia fruta' },
      { e: '🍇', k: 'uvas fruta' },
      { e: '🍓', k: 'fresa fruta' },
      { e: '🫐', k: 'arandano fruta' },
      { e: '🍒', k: 'cerezas fruta' },
      { e: '🍑', k: 'melocoton durazno fruta' },
      { e: '🥭', k: 'mango fruta' },
      { e: '🍍', k: 'piña fruta' },
      { e: '🥝', k: 'kiwi fruta' },
      { e: '🍅', k: 'tomate' },
      { e: '🥑', k: 'aguacate' },
      { e: '🥦', k: 'brocoli' },
      { e: '🌽', k: 'maiz' },
      { e: '🥕', k: 'zanahoria' },
      { e: '🍔', k: 'hamburguesa' },
      { e: '🍟', k: 'patatas fritas' },
      { e: '🍕', k: 'pizza' },
      { e: '🌮', k: 'taco' },
      { e: '🌯', k: 'burrito' },
      { e: '🍜', k: 'ramen fideos sopa' },
      { e: '🍣', k: 'sushi' },
      { e: '🍦', k: 'helado' },
      { e: '🍩', k: 'donut rosquilla' },
      { e: '🍪', k: 'galleta' },
      { e: '🎂', k: 'tarta pastel cumpleaños' },
      { e: '🍫', k: 'chocolate' },
      { e: '🍿', k: 'palomitas' },
      { e: '🧂', k: 'sal' },
      { e: '☕', k: 'cafe' },
      { e: '🍵', k: 'te infusion' },
      { e: '🍺', k: 'cerveza' },
      { e: '🥂', k: 'brindis copas' },
    ],
  },
  {
    id: 'actividades',
    etiqueta: '⚽',
    emojis: [
      { e: '⚽', k: 'futbol balon pelota' },
      { e: '🏀', k: 'baloncesto basket' },
      { e: '🏈', k: 'futbol americano' },
      { e: '⚾', k: 'beisbol' },
      { e: '🎾', k: 'tenis' },
      { e: '🏐', k: 'voleibol' },
      { e: '🎱', k: 'billar bola' },
      { e: '🏓', k: 'ping pong tenis mesa' },
      { e: '🎳', k: 'bolos' },
      { e: '🥅', k: 'porteria' },
      { e: '🎯', k: 'diana dardos' },
      { e: '🎮', k: 'videojuego mando' },
      { e: '🎲', k: 'dado azar' },
      { e: '🧩', k: 'puzzle rompecabezas' },
      { e: '🎸', k: 'guitarra' },
      { e: '🎹', k: 'piano teclado' },
      { e: '🎺', k: 'trompeta' },
      { e: '🎻', k: 'violin' },
      { e: '🥁', k: 'bateria tambor' },
      { e: '🎤', k: 'microfono cantar' },
      { e: '🎧', k: 'auriculares cascos' },
      { e: '🎬', k: 'cine pelicula claqueta' },
      { e: '🎨', k: 'arte pintura paleta' },
      { e: '🎭', k: 'teatro mascaras' },
      { e: '🏅', k: 'medalla' },
      { e: '🥇', k: 'oro primero medalla' },
      { e: '🥈', k: 'plata segundo medalla' },
      { e: '🥉', k: 'bronce tercero medalla' },
      { e: '🏆', k: 'trofeo copa' },
      { e: '🚴', k: 'ciclismo bici' },
      { e: '🏊', k: 'natacion nadar' },
      { e: '🧘', k: 'yoga meditacion' },
    ],
  },
  {
    id: 'viajes',
    etiqueta: '🚀',
    emojis: [
      { e: '🚗', k: 'coche auto' },
      { e: '🚕', k: 'taxi' },
      { e: '🚌', k: 'autobus bus' },
      { e: '🚑', k: 'ambulancia' },
      { e: '🚒', k: 'bomberos camion' },
      { e: '🚓', k: 'policia coche' },
      { e: '🏎️', k: 'carreras formula coche' },
      { e: '🚀', k: 'cohete espacio' },
      { e: '✈️', k: 'avion volar' },
      { e: '🚁', k: 'helicoptero' },
      { e: '⛵', k: 'velero barco' },
      { e: '🚢', k: 'barco crucero' },
      { e: '🚲', k: 'bici bicicleta' },
      { e: '🛵', k: 'moto scooter' },
      { e: '🏠', k: 'casa hogar' },
      { e: '🏢', k: 'edificio oficina' },
      { e: '🏥', k: 'hospital' },
      { e: '🏦', k: 'banco' },
      { e: '🏨', k: 'hotel' },
      { e: '🏫', k: 'escuela colegio' },
      { e: '🏰', k: 'castillo' },
      { e: '🗼', k: 'torre' },
      { e: '🗽', k: 'estatua libertad' },
      { e: '⛰️', k: 'montaña' },
      { e: '🌍', k: 'mundo tierra europa africa globo' },
      { e: '🌎', k: 'mundo tierra america globo' },
      { e: '🌏', k: 'mundo tierra asia globo' },
      { e: '🧭', k: 'brujula' },
      { e: '🗺️', k: 'mapa' },
      { e: '🏝️', k: 'isla' },
      { e: '🏖️', k: 'playa' },
      { e: '🏔️', k: 'montaña nieve' },
    ],
  },
  {
    id: 'objetos',
    etiqueta: '💡',
    emojis: [
      { e: '💻', k: 'portatil ordenador laptop' },
      { e: '🖥️', k: 'ordenador monitor pc' },
      { e: '⌨️', k: 'teclado' },
      { e: '🖱️', k: 'raton mouse' },
      { e: '📱', k: 'movil telefono celular' },
      { e: '☎️', k: 'telefono fijo' },
      { e: '🔋', k: 'bateria pila' },
      { e: '💡', k: 'bombilla idea luz' },
      { e: '🔦', k: 'linterna' },
      { e: '📷', k: 'camara foto' },
      { e: '🎥', k: 'camara video' },
      { e: '📺', k: 'television tele' },
      { e: '📚', k: 'libros' },
      { e: '📖', k: 'libro abierto leer' },
      { e: '📝', k: 'nota escribir memo' },
      { e: '✏️', k: 'lapiz' },
      { e: '🖊️', k: 'boligrafo' },
      { e: '📎', k: 'clip sujetapapeles' },
      { e: '📌', k: 'chincheta pin' },
      { e: '📍', k: 'pin ubicacion' },
      { e: '✂️', k: 'tijeras cortar' },
      { e: '📅', k: 'calendario fecha' },
      { e: '📆', k: 'calendario' },
      { e: '📊', k: 'grafico barras estadistica' },
      { e: '📈', k: 'grafico subir crecer' },
      { e: '📉', k: 'grafico bajar caer' },
      { e: '🗂️', k: 'archivador carpetas' },
      { e: '📁', k: 'carpeta' },
      { e: '📦', k: 'caja paquete' },
      { e: '🔍', k: 'lupa buscar' },
      { e: '🔔', k: 'campana notificacion' },
      { e: '⏰', k: 'despertador alarma reloj' },
      { e: '⏳', k: 'reloj arena tiempo' },
      { e: '💰', k: 'dinero bolsa' },
      { e: '💳', k: 'tarjeta credito' },
      { e: '🎁', k: 'regalo' },
    ],
  },
  {
    id: 'simbolos',
    etiqueta: '❤️',
    emojis: [
      { e: '❤️', k: 'corazon amor rojo' },
      { e: '🧡', k: 'corazon naranja' },
      { e: '💛', k: 'corazon amarillo' },
      { e: '💚', k: 'corazon verde' },
      { e: '💙', k: 'corazon azul' },
      { e: '💜', k: 'corazon morado' },
      { e: '🖤', k: 'corazon negro' },
      { e: '🤍', k: 'corazon blanco' },
      { e: '🤎', k: 'corazon marron' },
      { e: '💔', k: 'corazon roto' },
      { e: '❣️', k: 'corazon exclamacion' },
      { e: '💕', k: 'corazones amor' },
      { e: '➕', k: 'mas suma' },
      { e: '➖', k: 'menos resta' },
      { e: '✖️', k: 'por multiplicar' },
      { e: '➗', k: 'dividir division' },
      { e: '🟰', k: 'igual' },
      { e: '💲', k: 'dolar dinero' },
      { e: '🔴', k: 'circulo rojo' },
      { e: '🟠', k: 'circulo naranja' },
      { e: '🟡', k: 'circulo amarillo' },
      { e: '🟢', k: 'circulo verde' },
      { e: '🔵', k: 'circulo azul' },
      { e: '🟣', k: 'circulo morado' },
      { e: '⚫', k: 'circulo negro' },
      { e: '⚪', k: 'circulo blanco' },
      { e: '🟥', k: 'cuadrado rojo' },
      { e: '🟧', k: 'cuadrado naranja' },
      { e: '🟨', k: 'cuadrado amarillo' },
      { e: '🟩', k: 'cuadrado verde' },
      { e: '🟦', k: 'cuadrado azul' },
      { e: '🟪', k: 'cuadrado morado' },
      { e: '🔶', k: 'rombo naranja' },
      { e: '🔷', k: 'rombo azul' },
      { e: '⭐', k: 'estrella' },
      { e: '🌟', k: 'estrella brillante' },
    ],
  },
];

const TODOS: Emoji[] = CATEGORIAS.flatMap((c) => c.emojis);

/**
 * Selector de emojis para el icono del documento, con buscador por nombre.
 * Emite `pick` con el emoji elegido, `remove` para quitar el icono y `cerrar`
 * cuando debe ocultarse (clic fuera, Esc, o tras elegir).
 */
@Component({
  selector: 'app-emoji-picker',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './emoji-picker.html',
  styleUrl: './emoji-picker.scss',
})
export class EmojiPicker implements AfterViewInit {
  readonly pick = output<string>();
  readonly remove = output<void>();
  readonly cerrar = output<void>();
  /**
   * El usuario quiere usar una imagen suya como icono. Solo se avisa: elegir el
   * fichero e importarlo es cosa de quien nos usa, que es quien tiene el
   * servicio de assets y sabe en qué bóveda está.
   */
  readonly subirImagen = output<void>();

  @ViewChild('inputBuscar') private inputBuscar?: ElementRef<HTMLInputElement>;

  protected readonly categorias = CATEGORIAS;
  protected readonly activa = signal(CATEGORIAS[0].id);
  protected readonly busqueda = signal('');

  /** Emojis a mostrar: resultados del buscador, o la categoría activa. */
  protected readonly emojis = computed<Emoji[]>(() => {
    const q = normalizar(this.busqueda());
    if (!q) {
      return this.categorias.find((c) => c.id === this.activa())?.emojis ?? [];
    }
    return TODOS.filter((em) => normalizar(em.k).includes(q) || em.e.includes(q));
  });

  protected readonly buscando = computed(() => normalizar(this.busqueda()) !== '');

  ngAfterViewInit(): void {
    this.inputBuscar?.nativeElement.focus();
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    // Esc: primero limpia la búsqueda; si ya está vacía, cierra.
    if (this.busqueda()) {
      this.busqueda.set('');
    } else {
      this.cerrar.emit();
    }
  }

  protected elegirCategoria(id: string): void {
    this.busqueda.set(''); // salir del modo búsqueda al tocar una pestaña
    this.activa.set(id);
  }

  protected seleccionar(emoji: string): void {
    this.pick.emit(emoji);
    this.cerrar.emit();
  }

  protected aleatorio(): void {
    this.seleccionar(TODOS[Math.floor(Math.random() * TODOS.length)].e);
  }

  protected quitar(): void {
    this.remove.emit();
    this.cerrar.emit();
  }
}
