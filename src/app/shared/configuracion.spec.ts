import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialogRef } from '@angular/material/dialog';
import { provideNoopAnimations } from '@angular/platform-browser/animations';

import { ConfiguracionDialog } from './configuracion';
import { Boveda, BovedasService } from '../core/bovedas.service';
import { SecretosService } from '../core/secretos.service';
import {
  EstadoSincro,
  RepoGitHub,
  ResultadoSincro,
  SincroService,
  UsuarioGitHub,
} from '../core/sincro.service';

const ANA: UsuarioGitHub = { login: 'ana', nombre: 'Ana', avatar: null };

const BOVEDA: Boveda = {
  id: 'b1',
  nombre: 'Mis notas',
  ruta: '/datos/Workspace',
  soloLectura: false,
  soyDueno: true,
  sinAcceso: false,
};

const REPO: RepoGitHub = {
  nombre: 'mis-notas',
  completo: 'ana/mis-notas',
  url: 'https://github.com/ana/mis-notas.git',
  privado: true,
};

const SIN_REPO: EstadoSincro = {
  iniciado: true,
  remoto: null,
  pendientes: 0,
  ultimoCommit: null,
};

const CON_REPO: EstadoSincro = {
  ...SIN_REPO,
  remoto: 'https://github.com/ana/mis-notas.git',
};

/**
 * Los servicios reales hablan con Tauri y con GitHub, que no existen en los
 * tests. Aquí solo se comprueba la máquina de estados de la pantalla: es donde
 * está la lógica y donde un fallo dejaría al usuario sin saber qué botón pulsar.
 */
function montar(opciones: {
  usuario?: UsuarioGitHub | null;
  estado?: EstadoSincro;
  conectar?: () => Promise<ResultadoSincro>;
  rotar?: (actual: string, nueva: string) => Promise<number>;
}) {
  const cerrado = { valor: undefined as unknown };
  const mock: Partial<SincroService> = {
    usuario: signal(opciones.usuario ?? null),
    sincronizando: signal(false),
    ultima: signal(null),
    conflictos: signal<string[]>([]),
    restauradas: signal([]),
    error: signal(null),
    cargarSesion: () => Promise.resolve(opciones.usuario ?? null),
    estado: () => Promise.resolve(opciones.estado ?? SIN_REPO),
    listarRepos: () => Promise.resolve([REPO]),
    conectarRepo:
      opciones.conectar ??
      (() => Promise.resolve({ cambios: false, conflictos: [], restauradas: [], notas: 0 })),
    sincronizarSiProcede: () => Promise.resolve(null),
    desconectar: () => Promise.resolve(),
    cerrarSesion: () => Promise.resolve(),
  };

  const bovedasMock: Partial<BovedasService> = {
    lista: signal<Boveda[]>([BOVEDA]),
    activa: signal<Boveda | null>(BOVEDA),
    cargar: () => Promise.resolve(),
  };

  const secretosMock: Partial<SecretosService> = {
    configurado: signal(true),
    desbloqueado: signal(false),
    cargarEstado: () => Promise.resolve({ configurado: true, desbloqueado: false }),
    rotar: opciones.rotar ?? (() => Promise.resolve(3)),
    bloquear: () => Promise.resolve(),
  };

  TestBed.configureTestingModule({
    imports: [ConfiguracionDialog],
    providers: [
      provideNoopAnimations(),
      { provide: SincroService, useValue: mock },
      { provide: BovedasService, useValue: bovedasMock },
      { provide: SecretosService, useValue: secretosMock },
      {
        provide: MatDialogRef,
        useValue: { close: (v: unknown) => (cerrado.valor = v) },
      },
    ],
  });

  const fixture = TestBed.createComponent(ConfiguracionDialog);
  return { fixture, cerrado };
}

/** Acceso a lo `protected` del componente, que es lo que se está probando. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const interno = (f: { componentInstance: unknown }) => f.componentInstance as any;

describe('ConfiguracionDialog · navegación lateral', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('el rótulo más largo cabe en su recuadro, también en negrita', async () => {
    const { fixture } = montar({ usuario: ANA, estado: CON_REPO });
    // El fixture no pasa por MatDialog, que es quien fija el ancho: se le da a
    // mano para que la rejilla reparta como en la app.
    (fixture.nativeElement as HTMLElement).style.width = '760px';
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const activo = (fixture.nativeElement as HTMLElement).querySelector(
      '.cfg-nav-item.activo',
    ) as HTMLElement;
    expect(activo.textContent).toContain('Cuenta y sincronización');

    /* Seleccionar pone el rótulo en negrita, y en negrita ocupa más: con la
       columna a 200 px la última letra se salía del recuadro resaltado. */
    expect(getComputedStyle(activo).fontWeight).toBe('600');
    expect(activo.scrollWidth).toBeLessThanOrEqual(activo.clientWidth);
  });

  it('una sección alta se desplaza en vez de cortarse', async () => {
    const { fixture } = montar({ usuario: ANA, estado: CON_REPO });
    const el = fixture.nativeElement as HTMLElement;
    el.style.width = '760px';
    fixture.detectChanges();
    await fixture.whenStable();
    interno(fixture).seccion.set('secretos');
    fixture.detectChanges();

    const cfg = el.querySelector('.cfg') as HTMLElement;
    const panel = el.querySelector('.cfg-panel') as HTMLElement;
    /* Se achica el diálogo a la fuerza para provocar el desbordamiento sin
       depender de lo alta que sea la ventana donde corran los tests. */
    cfg.style.minHeight = '0';
    cfg.style.height = '160px';

    /* Un ítem de rejilla arranca con `min-height: auto` y no encoge por debajo
       de su contenido: el panel crecía más que el diálogo, MatDialog lo
       recortaba y su `overflow-y` no llegaba a activarse. */
    expect(panel.scrollHeight).withContext('hay contenido de sobra').toBeGreaterThan(
      panel.clientHeight,
    );
    expect(Math.round(panel.getBoundingClientRect().height)).toBe(
      Math.round(cfg.getBoundingClientRect().height),
    );
  });

  it('el aviso de rotación se lee como un párrafo, no en columnas', async () => {
    const { fixture } = montar({ usuario: ANA, estado: CON_REPO });
    const el = fixture.nativeElement as HTMLElement;
    el.style.width = '760px';
    fixture.detectChanges();
    await fixture.whenStable();
    interno(fixture).seccion.set('secretos');
    fixture.detectChanges();

    const aviso = Array.from(el.querySelectorAll<HTMLElement>('.cfg-aviso')).find((p) =>
      p.textContent?.includes('recifra todos los bloques'),
    )!;
    expect(aviso).withContext('el aviso está en la sección').toBeTruthy();

    /* Con `display: flex` cada `<strong>` era un ítem del contenedor, y los
       ítems flex se blockifican: el texto salía partido en columnas estrechas.
       En flujo normal siguen siendo `inline`. */
    const negritas = Array.from(aviso.querySelectorAll('strong'));
    expect(negritas.length).toBeGreaterThan(1);
    for (const n of negritas) {
      expect(getComputedStyle(n).display).withContext(n.textContent ?? '').toBe('inline');
    }
    expect(getComputedStyle(aviso).display).not.toBe('flex');
  });

  it('ninguna entrada desborda su recuadro', async () => {
    const { fixture } = montar({ usuario: ANA, estado: CON_REPO });
    (fixture.nativeElement as HTMLElement).style.width = '760px';
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const items = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('.cfg-nav-item'),
    );
    expect(items.length).toBe(4);
    for (const it of items) {
      expect(it.scrollWidth).withContext(it.textContent ?? '').toBeLessThanOrEqual(it.clientWidth);
    }
  });
});

describe('ConfiguracionDialog', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('sin sesión ofrece iniciar sesión con GitHub', async () => {
    const { fixture } = montar({ usuario: null });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(interno(fixture).estado()).toBe('fuera');
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).toContain('Iniciar sesión con GitHub');
  });

  it('con sesión y sin repositorio ofrece los DOS caminos', async () => {
    const { fixture } = montar({ usuario: ANA, estado: SIN_REPO });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(interno(fixture).estado()).toBe('dentro');
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    // Sin el segundo botón, el usuario que llega a su PC nuevo se queda
    // atascado: "crear repositorio" no le sirve de nada.
    expect(html).toContain('Crear un repositorio');
    expect(html).toContain('Conectar con uno existente');
  });

  it('con repositorio conectado muestra el repo y el botón de sincronizar', async () => {
    const { fixture } = montar({ usuario: ANA, estado: CON_REPO });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(interno(fixture).estado()).toBe('conectado');
    expect(interno(fixture).repoCorto()).toBe('ana/mis-notas');
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).toContain('Sincronizar ahora');
  });

  it('mientras espera la aprobación enseña el código y no otra cosa', async () => {
    const { fixture } = montar({ usuario: null });
    fixture.detectChanges();
    await fixture.whenStable();

    interno(fixture).codigo.set({ codigoUsuario: 'WDJB-MJHT', url: 'https://github.com/login/device' });
    fixture.detectChanges();

    expect(interno(fixture).estado()).toBe('esperando');
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).toContain('WDJB-MJHT');
    expect(html).not.toContain('Iniciar sesión con GitHub');
  });

  it('al conectar un repo que trae notas pide recargar la lista', async () => {
    const { fixture, cerrado } = montar({
      usuario: ANA,
      estado: SIN_REPO,
      conectar: () => Promise.resolve({ cambios: true, conflictos: [], restauradas: [], notas: 3 }),
    });
    fixture.detectChanges();
    await fixture.whenStable();

    await interno(fixture).conectar(REPO);

    // Si no se avisara, el usuario vería la barra lateral vacía después de
    // traerse sus notas.
    expect(cerrado.valor).toBe('recargar');
  });

  it('si conectar no trae nada, no cierra el diálogo', async () => {
    const { fixture, cerrado } = montar({
      usuario: ANA,
      estado: SIN_REPO,
      conectar: () => Promise.resolve({ cambios: false, conflictos: [], restauradas: [], notas: 0 }),
    });
    fixture.detectChanges();
    await fixture.whenStable();

    await interno(fixture).conectar(REPO);

    expect(cerrado.valor).toBeUndefined();
  });

  it('un fallo de GitHub se enseña y no rompe la pantalla', async () => {
    const { fixture } = montar({
      usuario: ANA,
      estado: SIN_REPO,
      conectar: () => Promise.reject(new Error('sin conexión')),
    });
    fixture.detectChanges();
    await fixture.whenStable();

    await interno(fixture).conectar(REPO);
    fixture.detectChanges();

    expect(interno(fixture).aviso()).toContain('sin conexión');
    expect(interno(fixture).ocupado()).toBeFalse();
  });
});

describe('ConfiguracionDialog · contraseña maestra', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function enSecretos(rotar?: (a: string, n: string) => Promise<number>) {
    const { fixture } = montar({ usuario: ANA, estado: CON_REPO, rotar });
    fixture.detectChanges();
    await fixture.whenStable();
    interno(fixture).seccion.set('secretos');
    fixture.detectChanges();
    return fixture;
  }

  it('avisa de que rotar no le quita a nadie lo que ya vio', async () => {
    const fixture = await enSecretos();
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';

    // Sin esto, el usuario puede creer que rotar expulsa a quien se fue.
    expect(html).toContain('no le quita a nadie lo que ya');
    expect(html).toContain('cambia las credenciales de verdad');
  });

  it('exige el mínimo de longitud en la contraseña nueva', async () => {
    let llamado = false;
    const fixture = await enSecretos(() => {
      llamado = true;
      return Promise.resolve(0);
    });
    interno(fixture).claveActual.set('la de siempre123');
    interno(fixture).claveNueva.set('corta');
    interno(fixture).claveRepetir.set('corta');

    await interno(fixture).rotarClave();

    expect(llamado).toBeFalse();
    expect(interno(fixture).aviso()).toContain('12');
  });

  it('no rota si las dos nuevas no coinciden', async () => {
    let llamado = false;
    const fixture = await enSecretos(() => {
      llamado = true;
      return Promise.resolve(0);
    });
    interno(fixture).claveActual.set('la de siempre123');
    interno(fixture).claveNueva.set('frase nueva larga');
    interno(fixture).claveRepetir.set('frase nueva larfa');

    await interno(fixture).rotarClave();

    expect(llamado).toBeFalse();
    expect(interno(fixture).aviso()).toContain('no coinciden');
  });

  it('al rotar dice cuántas notas se recifraron y limpia los campos', async () => {
    const fixture = await enSecretos(() => Promise.resolve(7));
    interno(fixture).claveActual.set('la de siempre123');
    interno(fixture).claveNueva.set('frase nueva larga');
    interno(fixture).claveRepetir.set('frase nueva larga');

    await interno(fixture).rotarClave();

    expect(interno(fixture).rotadas()).toBe(7);
    // No dejar contraseñas en cajas de texto después de usarlas.
    expect(interno(fixture).claveActual()).toBe('');
    expect(interno(fixture).claveNueva()).toBe('');
  });

  it('una contraseña actual equivocada se enseña y no rompe la pantalla', async () => {
    const fixture = await enSecretos(() => Promise.reject(new Error('contraseña incorrecta')));
    interno(fixture).claveActual.set('no es la buena');
    interno(fixture).claveNueva.set('frase nueva larga');
    interno(fixture).claveRepetir.set('frase nueva larga');

    await interno(fixture).rotarClave();

    expect(interno(fixture).aviso()).toContain('incorrecta');
    expect(interno(fixture).rotando()).toBeFalse();
  });
});
