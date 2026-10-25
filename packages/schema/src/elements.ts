/**
 * Kuratierte Referenztabelle der Elemente.
 *
 * Zweck: fuer Elemente muss die KI ueberhaupt keine Zahlen erfinden, nur die
 * Darstellung entwerfen. Die Pruefung ersetzt abweichende KI-Werte durch die
 * Werte dieser Tabelle und markiert das im `Provenance`-Eintrag. Das entfernt
 * die haeufigste Fehlerklasse - plausible, aber falsche Stoffdaten - zum Preis
 * von wenigen KB statischer Daten.
 *
 * Abdeckung, ehrlich benannt: Ordnungszahl, Symbol, deutscher Name und molare
 * Masse sind fuer alle 118 Elemente hinterlegt. Dichte, Schmelz- und Siedepunkt
 * nur fuer die im Unterricht gaengigen Elemente - fuer alle uebrigen sind diese
 * Felder leer, und die Pruefung kann sie dann nicht gegenpruefen. Sie uebernimmt
 * in diesem Fall den KI-Wert und vermerkt einen Hinweis.
 *
 * Quellenlage: Standardatomgewichte nach IUPAC, gerundet auf die hier
 * angegebenen Stellen. Dichten bei Raumtemperatur (Gase bei 0 degC, 101,325 kPa).
 * Schmelz- und Siedepunkte in Kelvin bei Normaldruck. Die Werte sind fuer die
 * Lehre ausreichend genau, nicht fuer metrologische Zwecke.
 */

export interface ElementReference {
  atomicNumber: number;
  symbol: string;
  /** Deutscher Name. */
  name: string;
  /** Molare Masse in g/mol. */
  molarMass: number;
  /** Dichte in kg/m^3 bei Raumtemperatur, Gase bei Normalbedingungen. */
  density?: number;
  /** Schmelzpunkt in Kelvin. */
  meltingPoint?: number;
  /** Siedepunkt in Kelvin. */
  boilingPoint?: number;
}

/**
 * Format je Zeile: Z|Symbol|Name|molareMasse|Dichte|Schmelzpunkt|Siedepunkt
 * Leere Felder bedeuten "nicht hinterlegt", nicht "null".
 */
const PACKED = `
1|H|Wasserstoff|1.008|0.0899|13.99|20.27
2|He|Helium|4.0026|0.1785|0.95|4.22
3|Li|Lithium|6.94|534|453.65|1603
4|Be|Beryllium|9.0122|1850|1560|2742
5|B|Bor|10.81|2340|2349|4200
6|C|Kohlenstoff|12.011|2267|3800|4300
7|N|Stickstoff|14.007|1.251|63.15|77.36
8|O|Sauerstoff|15.999|1.429|54.36|90.19
9|F|Fluor|18.998|1.696|53.48|85.03
10|Ne|Neon|20.18|0.9|24.56|27.07
11|Na|Natrium|22.99|968|370.94|1156
12|Mg|Magnesium|24.305|1738|923|1363
13|Al|Aluminium|26.982|2700|933.47|2792
14|Si|Silicium|28.085|2330|1687|3538
15|P|Phosphor|30.974|1823|317.3|553.65
16|S|Schwefel|32.06|2070|388.36|717.8
17|Cl|Chlor|35.45|3.214|171.6|239.11
18|Ar|Argon|39.95|1.784|83.81|87.3
19|K|Kalium|39.098|856|336.7|1032
20|Ca|Calcium|40.078|1550|1115|1757
21|Sc|Scandium|44.956|2985|1814|3109
22|Ti|Titan|47.867|4507|1941|3560
23|V|Vanadium|50.942|6110|2183|3680
24|Cr|Chrom|51.996|7140|2180|2944
25|Mn|Mangan|54.938|7470|1519|2334
26|Fe|Eisen|55.845|7874|1811|3134
27|Co|Cobalt|58.933|8900|1768|3200
28|Ni|Nickel|58.693|8908|1728|3186
29|Cu|Kupfer|63.546|8960|1357.77|2835
30|Zn|Zink|65.38|7140|692.68|1180
31|Ga|Gallium|69.723|5904|302.91|2673
32|Ge|Germanium|72.63|5323|1211.4|3106
33|As|Arsen|74.922|5727|1090|887
34|Se|Selen|78.971|4819|494|958
35|Br|Brom|79.904|3120|265.8|332
36|Kr|Krypton|83.798|3.75|115.79|119.93
37|Rb|Rubidium|85.468|1532|312.46|961
38|Sr|Strontium|87.62|2630|1050|1655
39|Y|Yttrium|88.906|4472|1799|3609
40|Zr|Zirconium|91.224|6511|2128|4682
41|Nb|Niob|92.906|8570|2750|5017
42|Mo|Molybdaen|95.95|10280|2896|4912
43|Tc|Technetium|98|11500|2430|4538
44|Ru|Ruthenium|101.07|12370|2607|4423
45|Rh|Rhodium|102.91|12450|2237|3968
46|Pd|Palladium|106.42|12023|1828.05|3236
47|Ag|Silber|107.87|10490|1234.93|2435
48|Cd|Cadmium|112.41|8650|594.22|1040
49|In|Indium|114.82|7310|429.75|2345
50|Sn|Zinn|118.71|7310|505.08|2875
51|Sb|Antimon|121.76|6697|903.78|1860
52|Te|Tellur|127.6|6240|722.66|1261
53|I|Iod|126.9|4940|386.85|457.4
54|Xe|Xenon|131.29|5.9|161.4|165.03
55|Cs|Caesium|132.91|1879|301.59|944
56|Ba|Barium|137.33|3510|1000|2170
57|La|Lanthan|138.91|6146|1193|3737
58|Ce|Cer|140.12|6689|1068|3716
59|Pr|Praseodym|140.91|6640|1208|3793
60|Nd|Neodym|144.24|7010|1297|3347
61|Pm|Promethium|145|7264|1315|3273
62|Sm|Samarium|150.36|7353|1345|2067
63|Eu|Europium|151.96|5244|1099|1802
64|Gd|Gadolinium|157.25|7901|1585|3546
65|Tb|Terbium|158.93|8219|1629|3503
66|Dy|Dysprosium|162.5|8551|1680|2840
67|Ho|Holmium|164.93|8795|1734|2993
68|Er|Erbium|167.26|9066|1802|3141
69|Tm|Thulium|168.93|9321|1818|2223
70|Yb|Ytterbium|173.05|6570|1097|1469
71|Lu|Lutetium|174.97|9841|1925|3675
72|Hf|Hafnium|178.49|13310|2506|4876
73|Ta|Tantal|180.95|16650|3290|5731
74|W|Wolfram|183.84|19250|3695|5828
75|Re|Rhenium|186.21|21020|3459|5869
76|Os|Osmium|190.23|22590|3306|5285
77|Ir|Iridium|192.22|22560|2719|4701
78|Pt|Platin|195.08|21450|2041.4|4098
79|Au|Gold|196.97|19300|1337.33|3129
80|Hg|Quecksilber|200.59|13534|234.32|629.88
81|Tl|Thallium|204.38|11850|577|1746
82|Pb|Blei|207.2|11340|600.61|2022
83|Bi|Bismut|208.98|9780|544.55|1837
84|Po|Polonium|209|9196|527|1235
85|At|Astat|210|6350|575|
86|Rn|Radon|222|9.73|202|211.5
87|Fr|Francium|223||300|950
88|Ra|Radium|226|5500|973|2010
89|Ac|Actinium|227|10070|1323|3471
90|Th|Thorium|232.04|11724|2115|5061
91|Pa|Protactinium|231.04|15370|1841|4300
92|U|Uran|238.03|19050|1405.3|4404
93|Np|Neptunium|237|20450|917|4273
94|Pu|Plutonium|244|19816|912.5|3505
95|Am|Americium|243|12000|1449|2880
96|Cm|Curium|247|13510|1613|3383
97|Bk|Berkelium|247|14780|1259|
98|Cf|Californium|251|15100|1173|
99|Es|Einsteinium|252|8840|1133|
100|Fm|Fermium|257||1800|
101|Md|Mendelevium|258||1100|
102|No|Nobelium|259||1100|
103|Lr|Lawrencium|266||1900|
104|Rf|Rutherfordium|267||2400|5800
105|Db|Dubnium|268|||
106|Sg|Seaborgium|269|||
107|Bh|Bohrium|270|||
108|Hs|Hassium|269|||
109|Mt|Meitnerium|278|||
110|Ds|Darmstadtium|281|||
111|Rg|Roentgenium|282|||
112|Cn|Copernicium|285|||
113|Nh|Nihonium|286|||
114|Fl|Flerovium|289|||
115|Mc|Moscovium|290|||
116|Lv|Livermorium|293|||
117|Ts|Tenness|294|||
118|Og|Oganesson|294|||
`;

function parseOptional(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

function buildTable(): ElementReference[] {
  const rows: ElementReference[] = [];
  for (const line of PACKED.trim().split("\n")) {
    const parts = line.split("|");
    const atomicNumber = Number(parts[0]);
    const symbol = (parts[1] ?? "").trim();
    const name = (parts[2] ?? "").trim();
    const molarMass = Number(parts[3]);
    if (!Number.isFinite(atomicNumber) || symbol === "" || !Number.isFinite(molarMass)) {
      throw new Error(`Referenztabelle: Zeile nicht lesbar: ${line}`);
    }
    const entry: ElementReference = { atomicNumber, symbol, name, molarMass };
    const density = parseOptional(parts[4]);
    const meltingPoint = parseOptional(parts[5]);
    const boilingPoint = parseOptional(parts[6]);
    if (density !== undefined) entry.density = density;
    if (meltingPoint !== undefined) entry.meltingPoint = meltingPoint;
    if (boilingPoint !== undefined) entry.boilingPoint = boilingPoint;
    rows.push(entry);
  }
  return rows;
}

export const ELEMENTS: readonly ElementReference[] = Object.freeze(buildTable());

const BY_SYMBOL = new Map(ELEMENTS.map((e) => [e.symbol.toLowerCase(), e]));
const BY_NAME = new Map(ELEMENTS.map((e) => [e.name.toLowerCase(), e]));
const BY_NUMBER = new Map(ELEMENTS.map((e) => [e.atomicNumber, e]));

export function elementByNumber(atomicNumber: number): ElementReference | undefined {
  return BY_NUMBER.get(atomicNumber);
}

/**
 * Sucht ein Element ueber Symbol ("Fe"), deutschen Namen ("Eisen") oder eine
 * Summenformel, die nur aus einem Element besteht ("O2" -> Sauerstoff).
 */
export function findElement(query: string): ElementReference | undefined {
  const key = query.trim().toLowerCase();
  if (key === "") return undefined;
  const direct = BY_SYMBOL.get(key) ?? BY_NAME.get(key);
  if (direct) return direct;
  // Einelementige Summenformel: Buchstaben gefolgt von einer Zahl, z.B. "o2".
  const match = /^([a-z]{1,2})(\d{1,3})$/.exec(key);
  if (match) return BY_SYMBOL.get(match[1]!);
  return undefined;
}

/**
 * Elektronenkonfiguration aus der Ordnungszahl per Aufbauprinzip.
 *
 * Bewusst berechnet statt von der KI geliefert: die Besetzungsreihenfolge ist
 * eine feste Regel, und eine KI, die 118 Konfigurationen aus dem Gedaechtnis
 * schreibt, irrt sich gelegentlich. Die echten Ausnahmen (Cr, Cu, Pd, ...)
 * stehen in `ChemicalProperties.electronConfigurationOverride` - die Regel
 * gilt, bis jemand sie begruendet uebersteuert.
 */
const ORBITAL_ORDER: ReadonlyArray<readonly [shell: number, label: string, capacity: number]> = [
  [1, "1s", 2],
  [2, "2s", 2],
  [2, "2p", 6],
  [3, "3s", 2],
  [3, "3p", 6],
  [4, "4s", 2],
  [3, "3d", 10],
  [4, "4p", 6],
  [5, "5s", 2],
  [4, "4d", 10],
  [5, "5p", 6],
  [6, "6s", 2],
  [4, "4f", 14],
  [5, "5d", 10],
  [6, "6p", 6],
  [7, "7s", 2],
  [5, "5f", 14],
  [6, "6d", 10],
  [7, "7p", 6],
];

export interface OrbitalOccupancy {
  /** Hauptquantenzahl - bestimmt, auf welche Schale die subatomare Ansicht zeichnet. */
  shell: number;
  /** Orbitalbezeichnung, z.B. "3d". */
  label: string;
  /** Besetzte Elektronen in diesem Orbital. */
  electrons: number;
}

export function electronConfiguration(atomicNumber: number): OrbitalOccupancy[] {
  if (!Number.isInteger(atomicNumber) || atomicNumber < 1 || atomicNumber > 118) {
    throw new Error(`Ordnungszahl ausserhalb 1..118: ${atomicNumber}`);
  }
  let remaining = atomicNumber;
  const result: OrbitalOccupancy[] = [];
  for (const [shell, label, capacity] of ORBITAL_ORDER) {
    if (remaining <= 0) break;
    const electrons = Math.min(capacity, remaining);
    result.push({ shell, label, electrons });
    remaining -= electrons;
  }
  return result;
}

/** Elektronen je Hauptschale - das, was die subatomare Ansicht als Ringe zeichnet. */
export function shellOccupancy(atomicNumber: number): number[] {
  const shells: number[] = [];
  for (const orbital of electronConfiguration(atomicNumber)) {
    const index = orbital.shell - 1;
    shells[index] = (shells[index] ?? 0) + orbital.electrons;
  }
  for (let i = 0; i < shells.length; i += 1) {
    if (shells[i] === undefined) shells[i] = 0;
  }
  return shells;
}
