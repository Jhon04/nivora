import { WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { EditorComponent } from './editor';
import { SLASH_ITEMS, SlashItem } from './slash-command';

/**
 * Las entradas del menú «/» son `protected` (solo las usa su plantilla). El test
 * las alcanza con este molde en vez de abrirlas: lo que se prueba es el
 * comportamiento del menú, no el contrato público del componente.
 */
interface MenuSlash {
  slashOpen: WritableSignal<boolean>;
  slashItems: WritableSignal<SlashItem[]>;
  slashIndex: WritableSignal<number>;
  slashMove: (delta: number) => void;
}

const ULTIMA = SLASH_ITEMS.length - 1;

describe('menú «/» · navegación con el teclado', () => {
  let fix: ComponentFixture<EditorComponent>;
  let menuComp: MenuSlash;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [EditorComponent] }).compileComponents();
    fix = TestBed.createComponent(EditorComponent);
    menuComp = fix.componentInstance as unknown as MenuSlash;

    menuComp.slashItems.set(SLASH_ITEMS);
    menuComp.slashOpen.set(true);
    fix.detectChanges();
  });

  afterEach(() => fix.destroy());

  const menu = (): HTMLElement => fix.nativeElement.querySelector('.slash-menu') as HTMLElement;

  /**
   * ¿Se ve ENTERA la entrada `i`?
   *
   * Es lo que hay que medir, y no `scrollTop`: `block: 'nearest'` desplaza lo
   * mínimo, así que al volver a la primera entrada deja `scrollTop` en 4 —el
   * padding del menú— y no en 0, con la entrada perfectamente visible.
   */
  const seVe = (i: number): boolean => {
    const e = menu().children[i].getBoundingClientRect();
    const c = menu().getBoundingClientRect();
    return Math.round(e.top) >= Math.round(c.top) && Math.round(e.bottom) <= Math.round(c.bottom);
  };

  const bajarHastaElFinal = (): void => {
    for (let i = 0; i < ULTIMA; i++) menuComp.slashMove(1);
    fix.detectChanges();
  };

  it('el bloque cifrado lleva la llave en blanco sobre el ámbar', () => {
    const i = SLASH_ITEMS.findIndex((it) => it.title === 'Bloque cifrado');
    const ico = menu().children[i].querySelector('.ico') as HTMLElement;

    // Ligadura de Material Icons, no el emoji: un emoji trae su propio color y
    // la 🔑 salía dorada entre glifos monocromos.
    expect(ico.textContent?.trim()).toBe('key');
    expect(ico.classList).toContain('material-icons');

    const css = getComputedStyle(ico);
    expect(css.color).toBe('rgb(255, 255, 255)');
    // Sobre el fondo del menú el blanco no se vería en el tema claro: la
    // casilla va rellena.
    expect(css.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  });

  it('el menú desborda: hay entradas que no se ven de entrada', () => {
    // Si esto dejara de cumplirse, los demás test pasarían sin probar nada.
    expect(menu().scrollHeight).toBeGreaterThan(menu().clientHeight);
    expect(seVe(ULTIMA)).toBeFalse();
  });

  it('baja el menú al llegar con las flechas a una entrada oculta', () => {
    bajarHastaElFinal();

    expect(menuComp.slashIndex()).toBe(ULTIMA);
    expect(menu().scrollTop).toBeGreaterThan(0, 'se quedó arriba y no se ve lo elegido');
    expect(seVe(ULTIMA)).toBeTrue();
  });

  it('vuelve arriba al dar la vuelta del último al primero', () => {
    bajarHastaElFinal();
    const abajo = menu().scrollTop;

    menuComp.slashMove(1); // del último al primero
    fix.detectChanges();

    expect(menuComp.slashIndex()).toBe(0);
    expect(menu().scrollTop).toBeLessThan(abajo);
    expect(seVe(0)).toBeTrue();
  });

  it('subiendo desde el primero llega al último y lo enseña', () => {
    menuComp.slashMove(-1);
    fix.detectChanges();

    expect(menuComp.slashIndex()).toBe(ULTIMA);
    expect(seVe(ULTIMA)).toBeTrue();
  });
});
