import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';

import { App } from './app';
import { DocumentosService } from './core/documentos.service';
import { AssetsService } from './core/assets.service';
import { Boveda, BovedasService } from './core/bovedas.service';
import { NotaRestaurada, SincroService } from './core/sincro.service';
import { Documento } from './models/documento.model';

const PERSONAL: Boveda = {
  id: 'b1',
  nombre: 'Mis notas',
  ruta: '/datos/Workspace',
  soloLectura: false,
  soyDueno: true,
  sinAcceso: false,
};
const EQUIPO: Boveda = {
  id: 'b2',
  nombre: 'Equipo',
  ruta: '/datos/Bovedas/equipo',
  soloLectura: false,
  soyDueno: true,
  sinAcceso: false,
};

/** Cuaderno de otra persona en el que sí puedes escribir (eres colaborador). */
const COMPARTIDA: Boveda = {
  id: 'b4',
  nombre: 'Cuaderno del equipo',
  ruta: '/datos/Bovedas/equipo-ana',
  soloLectura: false,
  soyDueno: false,
  sinAcceso: false,
};

/** Bóveda cuyo repositorio ya no está a nuestro alcance. */
const PERDIDA: Boveda = {
  id: 'b5',
  nombre: 'Notas del proyecto',
  ruta: '/datos/Bovedas/proyecto',
  soloLectura: false,
  soyDueno: false,
  sinAcceso: true,
};

/** Cuaderno que otra persona comparte sin dar permiso de escritura. */
const AJENA: Boveda = {
  id: 'b3',
  nombre: 'Apuntes de Ana',
  ruta: '/datos/Bovedas/ana',
  soloLectura: true,
  soyDueno: false,
  sinAcceso: false,
};

/**
 * Monta la app con todos los servicios simulados (los reales usan Tauri, que no
 * existe en los tests). `orden` va registrando las llamadas que importan: cambiar
 * de bóveda solo es correcto si ocurren en la secuencia debida.
 */
function montar(orden: string[] = [], inicial: Boveda = PERSONAL) {
  const docsMock: Partial<DocumentosService> = {
    listar: () => {
      orden.push('listar');
      return Promise.resolve([]);
    },
    listarTags: () => Promise.resolve([]),
    obtener: () => Promise.resolve(null),
    guardar: (doc: Documento) => {
      orden.push('guardar');
      return Promise.resolve({ ...doc, id: doc.id ?? 'nueva' });
    },
    eliminar: () => Promise.resolve(),
    buscar: () => Promise.resolve([]),
  };

  const assetsMock: Partial<AssetsService> = {
    iniciar: () => {
      orden.push('assets');
      return Promise.resolve();
    },
  };

  const activa = signal<Boveda | null>(inicial);
  const bovedasMock: Partial<BovedasService> = {
    lista: signal<Boveda[]>([PERSONAL, EQUIPO, AJENA, COMPARTIDA, PERDIDA]),
    activa,
    soloLectura: computed(() => activa()?.soloLectura ?? false),
    soyDueno: computed(() => activa()?.soyDueno ?? true),
    sinAcceso: computed(() => activa()?.sinAcceso ?? false),
    olvidar: (id: string) => {
      orden.push('olvidar');
      activa.set(PERSONAL);
      return Promise.resolve();
    },
    comprobarAcceso: () => {
      orden.push('comprobar');
      return Promise.resolve(true);
    },
    cargar: () => Promise.resolve(),
    cambiar: (id: string) => {
      orden.push('cambiar');
      const b = [PERSONAL, EQUIPO, AJENA, COMPARTIDA, PERDIDA].find((x) => x.id === id) ?? PERSONAL;
      activa.set(b);
      return Promise.resolve(b);
    },
    crear: (nombre: string) => {
      orden.push('crear');
      const b = {
        id: 'nueva',
        nombre,
        ruta: `/datos/Bovedas/${nombre}`,
        soloLectura: false,
        soyDueno: true,
        sinAcceso: false,
      };
      activa.set(b);
      return Promise.resolve(b);
    },
  };

  const sincroMock: Partial<SincroService> = {
    usuario: signal(null),
    sincronizando: signal(false),
    ultima: signal(null),
    conflictos: signal<string[]>([]),
    restauradas: signal<NotaRestaurada[]>([]),
    error: signal(null),
    cargarSesion: () => Promise.resolve(null),
    sincronizarSiProcede: () => Promise.resolve(null),
  };

  TestBed.configureTestingModule({
    imports: [App],
    providers: [
      provideNoopAnimations(),
      { provide: DocumentosService, useValue: docsMock },
      { provide: AssetsService, useValue: assetsMock },
      { provide: BovedasService, useValue: bovedasMock },
      { provide: SincroService, useValue: sincroMock },
    ],
  });

  return TestBed.createComponent(App);
}

/** Acceso a lo `protected`/`private` del componente, que es lo que se prueba. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const interno = (f: { componentInstance: unknown }) => f.componentInstance as any;

describe('App', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('crea la app', () => {
    expect(montar().componentInstance).toBeTruthy();
  });

  it('la cabecera muestra la bóveda abierta', async () => {
    const fixture = montar();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain('Mis notas');
  });

  it('muestra el estado vacío cuando no hay documentos', async () => {
    const fixture = montar();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.vacio')?.textContent).toContain('Sin documentos');
  });

  it('muestra el marcador cuando no hay documento abierto', async () => {
    const fixture = montar();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.placeholder')?.textContent).toContain(
      'Selecciona un documento',
    );
  });
});

describe('App · cambio de bóveda', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function conDocumentoAbierto(orden: string[]) {
    const fixture = montar(orden);
    fixture.detectChanges();
    await fixture.whenStable();
    interno(fixture).actual.set({ titulo: 'Borrador', contenido: { type: 'doc', content: [] } });
    return fixture;
  }

  it('guarda lo pendiente ANTES de cambiar, no después', async () => {
    const orden: string[] = [];
    const fixture = await conDocumentoAbierto(orden);
    // El usuario escribe y deja un guardado esperando en el temporizador.
    interno(fixture).programarGuardado();
    orden.length = 0;

    await interno(fixture).cambiarBoveda(EQUIPO.id);

    // Si el guardado saliera después del cambio, esa nota se escribiría en la
    // bóveda de destino: aparecería duplicada donde no toca.
    expect(orden.indexOf('guardar')).toBeGreaterThanOrEqual(0);
    expect(orden.indexOf('guardar')).toBeLessThan(orden.indexOf('cambiar'));
  });

  it('rehace la carpeta de assets DESPUÉS de cambiar', async () => {
    const orden: string[] = [];
    const fixture = await conDocumentoAbierto(orden);
    orden.length = 0;

    await interno(fixture).cambiarBoveda(EQUIPO.id);

    // Al revés se fijaría la carpeta de la bóveda que estamos abandonando, y las
    // imágenes de la nueva no aparecerían.
    expect(orden.indexOf('assets')).toBeGreaterThan(orden.indexOf('cambiar'));
  });

  it('cierra el documento abierto', async () => {
    const fixture = await conDocumentoAbierto([]);

    await interno(fixture).cambiarBoveda(EQUIPO.id);

    // El documento es de la bóveda anterior: si se quedara abierto, seguir
    // escribiendo lo guardaría como nota nueva en la bóveda de destino.
    expect(interno(fixture).actual()).toBeNull();
    expect(interno(fixture).estadoGuardado()).toBe('idle');
  });

  it('limpia la búsqueda y el filtro por etiqueta', async () => {
    const fixture = await conDocumentoAbierto([]);
    interno(fixture).busqueda.set('presupuesto');
    interno(fixture).filtroTag.set('trabajo');

    await interno(fixture).cambiarBoveda(EQUIPO.id);

    // Apuntaban a notas de la bóveda anterior, que aquí no existen.
    expect(interno(fixture).busqueda()).toBe('');
    expect(interno(fixture).filtroTag()).toBeNull();
  });

  it('recarga la lista con las notas de la bóveda nueva', async () => {
    const orden: string[] = [];
    const fixture = await conDocumentoAbierto(orden);
    orden.length = 0;

    await interno(fixture).cambiarBoveda(EQUIPO.id);

    expect(orden.indexOf('listar')).toBeGreaterThan(orden.indexOf('cambiar'));
    expect(interno(fixture).bovedas.activa().nombre).toBe('Equipo');
  });

  it('pulsar la bóveda que ya está abierta no hace nada', async () => {
    const orden: string[] = [];
    const fixture = await conDocumentoAbierto(orden);
    orden.length = 0;

    await interno(fixture).cambiarBoveda(PERSONAL.id);

    expect(orden).toEqual([]);
    // Y sobre todo: no cierra lo que el usuario tenía abierto.
    expect(interno(fixture).actual()).not.toBeNull();
  });

  it('crear una bóveda también vacía lo pendiente y rehace los assets', async () => {
    const orden: string[] = [];
    const fixture = await conDocumentoAbierto(orden);
    interno(fixture).programarGuardado();
    interno(fixture).nombreBovedaNueva.set('Recetas');
    orden.length = 0;

    await interno(fixture).crearBoveda();

    expect(orden.indexOf('guardar')).toBeLessThan(orden.indexOf('crear'));
    expect(orden.indexOf('assets')).toBeGreaterThan(orden.indexOf('crear'));
    expect(interno(fixture).actual()).toBeNull();
    expect(interno(fixture).nombreBovedaNueva()).toBe('');
  });

  it('sin nombre no crea ninguna bóveda', async () => {
    const orden: string[] = [];
    const fixture = await conDocumentoAbierto(orden);
    interno(fixture).nombreBovedaNueva.set('   ');
    orden.length = 0;

    await interno(fixture).crearBoveda();

    expect(orden).toEqual([]);
  });
});

describe('App · bóveda de solo lectura', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function enBovedaAjena() {
    const orden: string[] = [];
    const fixture = montar(orden, AJENA);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, orden };
  }

  it('no ofrece crear ni borrar notas', async () => {
    const { fixture } = await enBovedaAjena();
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';

    expect(html).toContain('Solo lectura');
    // El botón «Nuevo» crearía una nota en el cuaderno de otra persona.
    expect(html).not.toContain('Nuevo');
  });

  it('NO guarda aunque llegue una edición', async () => {
    const { fixture, orden } = await enBovedaAjena();
    interno(fixture).actual.set({ titulo: 'Intruso', contenido: { type: 'doc', content: [] } });
    orden.length = 0;

    interno(fixture).programarGuardado();
    await interno(fixture).flushGuardado();

    // Freno de fondo: aunque un control se escape de la plantilla, no se escribe
    // en el cuaderno ajeno.
    expect(orden).not.toContain('guardar');
  });

  it('el editor se monta bloqueado', async () => {
    const { fixture } = await enBovedaAjena();
    interno(fixture).actual.set({ titulo: 'Apunte', contenido: { type: 'doc', content: [] } });
    fixture.detectChanges();
    await fixture.whenStable();

    // Apagar ProseMirror es lo único que corta también el teclado, el pegado y
    // el menú «/».
    expect(interno(fixture).bovedas.soloLectura()).toBeTrue();
  });

  it('volver a una bóveda propia devuelve la escritura', async () => {
    const { fixture, orden } = await enBovedaAjena();
    orden.length = 0;

    await interno(fixture).cambiarBoveda(PERSONAL.id);
    fixture.detectChanges();

    // Que un cuaderno compartido sea de solo lectura no puede contagiarse a las
    // notas propias del usuario.
    expect(interno(fixture).bovedas.soloLectura()).toBeFalse();
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).toContain('Nuevo');
  });
});

describe('App · notas bloqueadas en una bóveda compartida', () => {
  afterEach(() => TestBed.resetTestingModule());

  /** Colaborador dentro del cuaderno de otra persona. */
  async function comoColaborador(nota: { bloqueada: boolean }) {
    const orden: string[] = [];
    const fixture = montar(orden, COMPARTIDA);
    fixture.detectChanges();
    await fixture.whenStable();
    interno(fixture).actual.set({
      id: 'n1',
      titulo: 'Una nota',
      bloqueada: nota.bloqueada,
      contenido: { type: 'doc', content: [] },
    });
    fixture.detectChanges();
    return { fixture, orden };
  }

  it('el colaborador SÍ puede editar una nota sin candado', async () => {
    const { fixture, orden } = await comoColaborador({ bloqueada: false });
    orden.length = 0;

    expect(interno(fixture).puedeEditar()).toBeTrue();
    interno(fixture).programarGuardado();
    await interno(fixture).flushGuardado();
    expect(orden).toContain('guardar');
  });

  it('el colaborador NO puede editar una nota bloqueada', async () => {
    const { fixture, orden } = await comoColaborador({ bloqueada: true });
    orden.length = 0;

    expect(interno(fixture).puedeEditar()).toBeFalse();
    interno(fixture).programarGuardado();
    await interno(fixture).flushGuardado();
    // La interfaz es solo cortesía; aun así no debe intentarlo.
    expect(orden).not.toContain('guardar');
  });

  it('el colaborador no puede mover el candado', async () => {
    const { fixture, orden } = await comoColaborador({ bloqueada: true });
    orden.length = 0;

    await interno(fixture).alternarBloqueo();

    expect(interno(fixture).actual().bloqueada).toBeTrue();
    expect(orden).not.toContain('guardar');
  });

  it('el dueño edita y bloquea sus propias notas', async () => {
    const orden: string[] = [];
    const fixture = montar(orden, PERSONAL);
    fixture.detectChanges();
    await fixture.whenStable();
    interno(fixture).actual.set({
      id: 'n1',
      titulo: 'Mía',
      bloqueada: true,
      contenido: { type: 'doc', content: [] },
    });
    orden.length = 0;

    // Bloqueada o no, en su propia bóveda el dueño manda.
    expect(interno(fixture).puedeEditar()).toBeTrue();
    await interno(fixture).alternarBloqueo();

    expect(interno(fixture).actual().bloqueada).toBeFalse();
    expect(orden).toContain('guardar');
  });
});

describe('App · aviso de notas restauradas', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function conRestauradas(notas: NotaRestaurada[]) {
    const fixture = montar();
    fixture.detectChanges();
    await fixture.whenStable();
    interno(fixture).sincro.restauradas.set(notas);
    fixture.detectChanges();
    return fixture;
  }

  it('avisa nombrando la nota que alguien tocó', async () => {
    const fixture = await conRestauradas([
      { id: 'n1', titulo: 'Manual del equipo', copia: 'n1.conflicto-20260728.json' },
    ]);

    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).toContain('Se restauró una nota bloqueada');
    // El título importa: un UUID no le dice nada al usuario.
    expect(html).toContain('Manual del equipo');
  });

  it('con varias notas lo dice en plural y las lista', async () => {
    const fixture = await conRestauradas([
      { id: 'n1', titulo: 'Manual', copia: null },
      { id: 'n2', titulo: 'Precios', copia: null },
    ]);

    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).toContain('Se restauraron 2 notas bloqueadas');
    expect(html).toContain('Manual');
    expect(html).toContain('Precios');
  });

  it('sin restauraciones no se ve nada', async () => {
    const fixture = await conRestauradas([]);
    expect((fixture.nativeElement as HTMLElement).querySelector('.aviso-restauradas')).toBeNull();
  });

  it('se puede descartar', async () => {
    const fixture = await conRestauradas([{ id: 'n1', titulo: 'Manual', copia: null }]);

    interno(fixture).descartarRestauradas();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).querySelector('.aviso-restauradas')).toBeNull();
  });

  it('cambiar de bóveda limpia el aviso', async () => {
    const fixture = await conRestauradas([{ id: 'n1', titulo: 'Manual', copia: null }]);

    await interno(fixture).cambiarBoveda(EQUIPO.id);
    fixture.detectChanges();

    // El aviso era de la bóveda anterior: dejarlo puesto confundiría.
    expect(interno(fixture).sincro.restauradas()).toEqual([]);
  });
});

describe('App · bóveda sin acceso', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function enBovedaPerdida(orden: string[] = []) {
    const fixture = montar(orden, PERDIDA);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  it('lo dice claro y ofrece comprobar o quitar', async () => {
    const fixture = await enBovedaPerdida();
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';

    expect(html).toContain('Ya no tienes acceso a este repositorio');
    expect(html).toContain('Volver a comprobar');
    expect(html).toContain('Quitar bóveda');
  });

  it('NO borra la bóveda por su cuenta', async () => {
    const orden: string[] = [];
    await enBovedaPerdida(orden);

    // Puede tener notas del propio usuario, y borrar ficheros porque un tercero
    // pulsó algo en GitHub sería una puerta trasera. Quitarla es decisión suya.
    expect(orden).not.toContain('olvidar');
  });

  it('deja de intentar sincronizar', async () => {
    const orden: string[] = [];
    const fixture = await enBovedaPerdida(orden);
    orden.length = 0;

    await interno(fixture).sincronizarEnSegundoPlano();

    // Reintentarlo dejaría la app dando el mismo error en cada guardado.
    expect(orden).toEqual([]);
  });

  it('«Volver a comprobar» vuelve a preguntar a GitHub', async () => {
    const orden: string[] = [];
    const fixture = await enBovedaPerdida(orden);
    orden.length = 0;

    await interno(fixture).reintentarAcceso();

    expect(orden).toContain('comprobar');
  });
});
