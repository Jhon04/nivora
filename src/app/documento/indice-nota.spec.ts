import { ComponentFixture, TestBed } from '@angular/core/testing';

import { IndiceNota } from './indice-nota';
import { EntradaIndice } from '../editor/indice';

const ENTRADAS: EntradaIndice[] = [
  { pos: 0, nivel: 1, texto: 'Introducción', sangria: 0 },
  { pos: 40, nivel: 2, texto: 'Antecedentes', sangria: 1 },
  { pos: 90, nivel: 2, texto: 'Metodología', sangria: 1 },
  { pos: 150, nivel: 1, texto: 'Conclusiones', sangria: 0 },
];

describe('IndiceNota · buscador', () => {
  let fix: ComponentFixture<IndiceNota>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [IndiceNota] }).compileComponents();
    fix = TestBed.createComponent(IndiceNota);
    fix.componentRef.setInput('entradas', ENTRADAS);
    fix.detectChanges();
  });

  afterEach(() => fix.destroy());

  /** El filtro es `protected` (solo lo usa su plantilla); el test lo alcanza. */
  const filtrar = (texto: string): void => {
    (fix.componentInstance as unknown as { filtro: { set: (s: string) => void } }).filtro.set(
      texto,
    );
    fix.detectChanges();
  };

  const items = (): HTMLElement[] =>
    Array.from(fix.nativeElement.querySelectorAll('.indice-item'));

  const textos = (): string[] => items().map((b) => (b.textContent ?? '').trim());

  it('sin filtro salen todas las secciones', () => {
    expect(textos()).toEqual(['Introducción', 'Antecedentes', 'Metodología', 'Conclusiones']);
  });

  it('filtra por texto y sin distinguir acentos ni mayúsculas', () => {
    filtrar('METODOLOGIA');

    // Nadie espera tener que escribir «Metodología» con tilde para encontrarla.
    expect(textos()).toEqual(['Metodología']);
  });

  it('al pulsar un resultado salta a SU sección, no a la primera de la lista', (done) => {
    filtrar('conclu');
    expect(textos()).toEqual(['Conclusiones']);

    // El riesgo del filtro: emitir la posición dentro de la lista filtrada (0)
    // llevaría a «Introducción». Tiene que viajar el puesto real, el 3.
    fix.componentInstance.irA.subscribe((i) => {
      expect(i).toBe(3);
      done();
    });
    items()[0].click();
  });

  it('el resaltado sigue a la sección que se lee, también al filtrar', () => {
    fix.componentRef.setInput('activo', 3); // se está leyendo «Conclusiones»
    filtrar('e'); // deja fuera «Introducción», que no lleva ninguna «e»

    /* Si el resaltado se comparase contra la posición dentro de la lista
       filtrada, aquí no se marcaría nada: «Conclusiones» pasa a ser la 2.ª. */
    expect(textos()).toEqual(['Antecedentes', 'Metodología', 'Conclusiones']);
    const marcados = items()
      .filter((b) => b.classList.contains('activo'))
      .map((b) => (b.textContent ?? '').trim());
    expect(marcados).toEqual(['Conclusiones']);
  });

  it('sin coincidencias lo dice, y no se queda en blanco', () => {
    filtrar('presupuesto');

    expect(items().length).toBe(0);
    expect((fix.nativeElement as HTMLElement).textContent).toContain('Ninguna sección coincide');
  });

  it('una nota sin títulos no enseña ni el buscador', () => {
    fix.componentRef.setInput('entradas', []);
    fix.detectChanges();

    // Un buscador sobre una lista vacía solo estorba.
    expect(fix.nativeElement.querySelector('.indice-buscador')).toBeNull();
    expect((fix.nativeElement as HTMLElement).textContent).toContain('Pon las secciones como');
  });
});
