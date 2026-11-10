"""Product search by word stems: "огурец" finds "Огурцы свежие", "яблоко" finds "Яблоки"."""
import re

# Endings that change between "огурец / огурцы", "яблоко / яблоки", "гречку / гречка", "свежие / свежий"
ENDINGS = ("ами", "ями", "ого", "его", "ому", "ему", "ыми", "ими", "ов", "ев", "ей", "ам", "ям", "ах", "ях", "ой", "ий", "ый",
           "ая", "яя", "ое", "ее", "ые", "ие", "ую", "юю", "ец", "ок", "ек", "а", "я", "о", "е", "ы", "и", "у", "ю", "ь", "й")


def stems(q: str) -> list[str]:
    """Every word of the query must appear, by its stem: "огурец" finds "Огурцы свежие", "сыр гауда" finds "Сыр Гауда"."""
    out = []
    for w in q.split():
        for e in ENDINGS:
            if w.endswith(e) and len(w) - len(e) >= 3:
                w = w[: -len(e)]
                break
        out.append(w)
    return out


def word_start(column, stem: str):
    """`column` has a word starting with `stem` ("огур" matches "Огурцы", not "йогурт")."""
    return column.op("~")(r"(^|[^0-9a-zа-я])" + re.escape(stem))
