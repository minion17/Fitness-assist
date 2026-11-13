"""Product search the way people type: word stems ("огурец" → "Огурцы"), everyday words ("картошка" → "Картофель"),
the wrong keyboard layout ("ucbxrf" → "гречка"), Latin brands ("activia" → "Активиа") and typos ("гричка" → "Гречка")."""
import re
from difflib import SequenceMatcher

# Endings that change between "огурец / огурцы", "яблоко / яблоки", "гречку / гречка", "свежие / свежий"
ENDINGS = ("ами", "ями", "ого", "его", "ому", "ему", "ыми", "ими", "ов", "ев", "ей", "ам", "ям", "ах", "ях", "ой", "ий", "ый",
           "ая", "яя", "ое", "ее", "ые", "ие", "ую", "юю", "ец", "ок", "ек", "а", "я", "о", "е", "ы", "и", "у", "ю", "ь", "й")

# Everyday word -> the words the catalog uses (each searched by its stem too). Written without "ё".
SYNONYMS = {
    "картошка": ["картофель"], "картоха": ["картофель"], "картошечка": ["картофель"], "пюрешка": ["пюре"],
    "томат": ["помидор"], "томаты": ["помидор"], "помидорка": ["помидор"], "помидорки": ["помидор"],
    "огурчик": ["огурец"], "огурчики": ["огурец"], "морковка": ["морковь"], "капустка": ["капуста"],
    "лучок": ["лук"], "чесночок": ["чеснок"], "зелень": ["укроп", "петрушка"],
    "яблочко": ["яблоко"], "мандаринка": ["мандарин"], "клубничка": ["клубника"], "вишенка": ["вишня"], "бананчик": ["банан"],
    "минералка": ["минеральная"], "минералочка": ["минеральная"], "газировка": ["лимонад", "кола"],
    "кола": ["кока-кола"], "пепси": ["кола"], "энергос": ["энергетик"], "энергетос": ["энергетик"],
    "пивас": ["пиво"], "пивко": ["пиво"], "винишко": ["вино"], "водочка": ["водка"], "кофеек": ["кофе"],
    "капучинка": ["капучино"], "чаек": ["чай"], "морсик": ["морс"], "компотик": ["компот"],
    "черный": ["ржаной", "бородинский", "дарницкий"], "белый": ["пшеничный", "батон"], "хлебушек": ["хлеб"], "булка": ["батон", "булочка"],
    "кура": ["курица"], "курочка": ["курица"], "курица": ["куриный"], "куриный": ["курица"], "куриная": ["курица"], "куриное": ["курица"],
    "грудка": ["филе"], "филе": ["грудка"], "говядинка": ["говядина"], "свининка": ["свинина"], "фаршик": ["фарш"],
    "колбаска": ["колбаса"], "сосиска": ["сосиски"], "сарделька": ["сардельки"],
    "котлетка": ["котлета"], "котлетки": ["котлета"], "пельмешки": ["пельмени"], "пельмеши": ["пельмени"],
    "варенички": ["вареники"], "блинчик": ["блины"], "блинчики": ["блины"], "оладушки": ["оладьи"], "оладушек": ["оладьи"],
    "сырнички": ["сырники"], "шаверма": ["шаурма"], "шаурма": ["шаверма"], "шавуха": ["шаурма"], "бутер": ["бутерброд"],
    "гречка": ["гречневая"], "гречневая": ["гречка"], "овсянка": ["овсяная", "овсяные"], "геркулес": ["овсяные"],
    "манка": ["манная"], "пшенка": ["пшенная"], "перловка": ["перловая"], "макарошки": ["макароны"], "рисик": ["рис"],
    "творожок": ["творог"], "молочко": ["молоко"], "кефирчик": ["кефир"], "йогуртик": ["йогурт"], "сметанка": ["сметана"],
    "маслице": ["масло"], "яичко": ["яйцо"], "яички": ["яйцо"],
    "печенька": ["печенье"], "печеньки": ["печенье"], "конфетка": ["конфеты"], "шоколадка": ["шоколад"],
    "мороженка": ["мороженое"], "мороженное": ["мороженое"], "тортик": ["торт"], "пироженка": ["пирожное"],
    "салатик": ["салат"], "супчик": ["суп"], "борщик": ["борщ"], "кашка": ["каша"], "протеинка": ["протеин"], "протик": ["протеин"],
    "орешки": ["орех"], "семки": ["семечки"], "сухарики": ["сухари"],
}

EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`"
RU = "йцукенгшщзхъфывапролджэячсмитьбюе"
LAYOUT = str.maketrans(EN, RU)
TRANSLIT = [("shch", "щ"), ("sch", "щ"), ("zh", "ж"), ("kh", "х"), ("ts", "ц"), ("ch", "ч"), ("sh", "ш"), ("yu", "ю"),
            ("ya", "я"), ("yo", "е"), ("ck", "к"), ("ph", "ф"), ("oo", "у"), ("ee", "и"), ("x", "кс"), ("w", "в")]
LETTERS = dict(zip("abcdefghijklmnopqrstuvyz", "абкдефгхийклмнопкрстувыз"))
LETTER = "0-9a-zа-я"


def norm(q: str) -> str:
    return q.lower().replace("ё", "е")


def stem(w: str) -> str:
    for e in ENDINGS:
        if w.endswith(e) and len(w) - len(e) >= 3:
            return w[: -len(e)]
    return w


def stems(q: str) -> list[str]:
    """Every word of the query must appear, by its stem: "огурец" finds "Огурцы свежие", "сыр гауда" finds "Сыр Гауда"."""
    return [stem(w) for w in q.split()]


def translit(w: str) -> str:
    for lat, cyr in TRANSLIT:
        w = w.replace(lat, cyr)
    return "".join(LETTERS.get(c, c) for c in w)


def variants(word: str) -> list[str]:
    """The word as typed, its everyday synonyms, and for Latin input the wrong layout and a transliteration."""
    key = word if word in SYNONYMS or len(word) < 5 else max(SYNONYMS, key=lambda k: similar(word, k))
    if similar(word, key) < 0.85:
        key = word
    out = [word, key, *SYNONYMS.get(key, [])]  # a typo of an everyday word: "кртошка" -> "картошка" -> "картофель"
    if re.fullmatch(r"[a-z\[\];',.`]+", word):
        out += [word.translate(LAYOUT), translit(word)]
    return list(dict.fromkeys(out))


def alternatives(q: str) -> list[list[str]]:
    """Per query word, the stems any of which must start a word of the product ("картошка" → картошк | картофел)."""
    return [list(dict.fromkeys(stem(v) for v in variants(w))) for w in norm(q).split()]


def first_words(q: str) -> list[str]:
    """The first query word with its synonyms, whole: ranks "Картофель" above "Пирожное картошка"."""
    return [v for w in norm(q).split()[:1] for v in variants(w)]


def word_start(column, stem_: str):
    """`column` has a word starting with `stem_` ("огур" matches "Огурцы", not "йогурт")."""
    return column.op("~")(rf"(^|[^{LETTER}])" + re.escape(stem_))


def starts_with_word(column, word: str):
    return column.op("~")(rf"^{re.escape(word)}([^{LETTER}]|$)")


def has_word(column, word: str):
    return column.op("~")(rf"(^|[^{LETTER}]){re.escape(word)}([^{LETTER}]|$)")


def typo_pool(column, word: str):
    """Products with a word of about the same length and the same first letter: where a typo of `word` could be."""
    n = len(word)
    return column.op("~")(rf"(^|[^{LETTER}]){re.escape(word[0])}[{LETTER}]{{{max(n - 3, 1)},{n}}}([^{LETTER}]|$)")


SOUNDS = str.maketrans("оеяэы", "аиииы")  # unstressed vowels as spoken: "малако" ~ "молоко", "кифир" ~ "кефир"


def similar(a: str, b: str) -> float:
    return SequenceMatcher(None, a.translate(SOUNDS), b.translate(SOUNDS)).ratio()


def fuzzy_match(words: list[str], text: str, cutoff: float = 0.75) -> float:
    """How well every query word matches some word of `text`, a typo allowed ("гричка" ~ "гречка"); 0 if one doesn't."""
    names = re.findall(rf"[{LETTER}]+", text)
    total = 0.0
    for w in words:
        best = max((1.0 if n.startswith(stem(w)) else similar(w, n) for n in names), default=0.0)
        if best < cutoff:
            return 0.0
        total += best
    return total / len(words)
