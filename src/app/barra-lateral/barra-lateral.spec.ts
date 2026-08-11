import { TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';

import { BarraLateral } from './barra-lateral';
import { Boveda, BovedasService } from '../core/bovedas.service';
import { DocumentosService } from '../core/documentos.service';
import { SincroService } from '../core/sincro.service';

const PERSONAL: Boveda = {
  id: 'b1',
  nombre: 'Mis notas',
  ruta: '/datos/Workspace',
  soloLectura: false,
  soyDueno: true,
  sinAcceso: false,
};

/**
 * La barra no cambia nada por su cuenta: avisa a la app. Lo que se prueba aquí
 * es justo eso — qué sale por los eventos y qué se queda dentro.
 */
function montar() {
  const activa = signal<Boveda | null>(PERSONAL);
  const bovedasMock: Partial<BovedasService> = {
    lista: signal<Boveda[]>([PERSONAL]),
    activa,
    soloLectura: computed(() => false),
    soyDueno: computed(() => true),
    sinAcceso: computed(() => false),
  };

  const docsMock: Partial<DocumentosService> = {
    listar: () => Promise.resolve([]),
    listarTags: () => Promise.resolve([]),
    buscar: () => Promise.resolve([]),
  };

  const sincroMock: Partial<SincroService> = { sincronizando: signal(false) };

  TestBed.configureTestingModule({
    imports: [BarraLateral],
    providers: [
      { provide: BovedasService, useValue: bovedasMock },
      { provide: DocumentosService, useValue: docsMock },
      { provide: SincroService, useValue: sincroMock },
    ],
  });

  return TestBed.createComponent(BarraLateral);
}

/** Acceso a lo `protected` del componente, que es lo que se prueba. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const interno = (f: { componentInstance: unknown }) => f.componentInstance as any;

describe('BarraLateral · bóveda nueva', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('pide la bóveda con el nombre limpio y vacía el campo', () => {
    const fixture = montar();
    const nombres: string[] = [];
    fixture.componentInstance.crearBoveda.subscribe((n: string) => nombres.push(n));

    interno(fixture).nombreBovedaNueva.set('  Recetas  ');
    interno(fixture).pedirBovedaNueva();

    expect(nombres).toEqual(['Recetas']);
    // Si no se vaciara, el nombre reaparecería la próxima vez que se abre el
    // desplegable, sobre una bóveda que ya existe.
    expect(interno(fixture).nombreBovedaNueva()).toBe('');
    expect(interno(fixture).menuBovedas()).toBeFalse();
  });

  it('sin nombre no pide nada', () => {
    const fixture = montar();
    const nombres: string[] = [];
    fixture.componentInstance.crearBoveda.subscribe((n: string) => nombres.push(n));

    interno(fixture).nombreBovedaNueva.set('   ');
    interno(fixture).pedirBovedaNueva();

    expect(nombres).toEqual([]);
  });
});

describe('BarraLateral · lista', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('borrar no abre además la nota', () => {
    const fixture = montar();
    const borrados: string[] = [];
    fixture.componentInstance.eliminarDoc.subscribe((id: string) => borrados.push(id));
    const abiertos: string[] = [];
    fixture.componentInstance.abrirDoc.subscribe((id: string) => abiertos.push(id));

    // El botón de borrar vive DENTRO de la fila que abre la nota.
    const ev = new MouseEvent('click', { bubbles: true });
    interno(fixture).pedirBorrado('n1', ev);

    expect(borrados).toEqual(['n1']);
    expect(abiertos).toEqual([]);
  });

  it('parte el fragmento por las marcas de término encontrado', () => {
    const fixture = montar();

    // U+0002 abre y U+0003 cierra: es lo que manda Rust en los resultados.
    const partes = interno(fixture).partesFragmento('antes clave después');

    expect(partes).toEqual([
      { t: 'antes ', hl: false },
      { t: 'clave', hl: true },
      { t: ' después', hl: false },
    ]);
  });
});
