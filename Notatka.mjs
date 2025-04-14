/* -- Imports -- */

// Klienty do transkrypcji i modeli językowych
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

// Klienty do baz danych
import { Client } from "@notionhq/client"; // SDK Notion

// Narzędzia do obsługi audio
import { parseFile } from "music-metadata"; // Parser do określenia czasu trwania audio
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg"; // ffmpeg do dzielenia plików

// Narzędzia do przetwarzania tekstu
import natural from "natural"; // Tokenizacja zdań
import { franc } from "franc"; // Wykrywanie języka
import { encode, decode } from "gpt-3-encoder"; // Tokenizacja dla modeli GPT

// Narzędzia do obsługi ograniczeń i błędów
import Bottleneck from "bottleneck"; // Obsługa równoległych żądań
import retry from "async-retry"; // Obsługa ponawiania żądań

// Narzędzia Node.js
import stream from "stream"; // Obsługa strumieni
import { promisify } from "util"; // Promisyfikacja
import fs from "fs"; // System plików
import got from "got"; // Żądania HTTP
import { inspect } from "util"; // Inspekcja obiektów
import { join, extname } from "path"; // Obsługa ścieżek
import { exec } from "child_process"; // Komendy powłoki
import { spawn } from "child_process"; // Uruchamianie procesów

// Pliki pomocnicze projektu
import lang from "./helpers/languages.mjs"; // Kody języków
import EMOJI from "./helpers/emoji.mjs"; // Lista emoji
import { jsonrepair } from "jsonrepair"; // Naprawa nieprawidłowego JSON

const execAsync = promisify(exec);

// Konfiguracja globalna
const config = {
  filePath: "",
  chunkDir: "",
  supportedMimes: [".mp3", ".m4a", ".wav", ".mp4", ".mpeg", ".mpga", ".webm"],
  no_duration_flag: false,
};

export default {
  name: "Notatki głosowe do Notion",
  description: "Transkrybuje pliki audio, tworzy podsumowanie i wysyła je do Notion.",
  key: "notion-notatki-glosowe",
  version: "1.0.0",
  type: "action",
  props: {
    steps: {
      type: "object",
      label: "Dane poprzedniego kroku",
      description: `Te dane są automatycznie przekazywane z poprzednich kroków. Domyślna wartość to **{{steps}}**`,
      optional: false
    },
    notion: {
      type: "app",
      app: "notion",
      label: "Konto Notion",
      description: `⬆ Nie zapomnij połączyć swojego konta Notion! Upewnij się, że nadałeś dostęp do bazy danych Notatek.`,
    },
    databaseID: {
      type: "string",
      label: "Baza danych Notatki",
      description: "Wybierz bazę danych Notion.",
      async options({ query, prevContext }) {
        if (this.notion) {
          try {
            const notion = new Client({
              auth: this.notion.$auth.oauth_access_token,
            });

            let start_cursor = prevContext?.cursor;

            const response = await notion.search({
              ...(query ? { query } : {}),
              ...(start_cursor ? { start_cursor } : {}),
              page_size: 50,
              filter: {
                value: "database",
                property: "object",
              },
              sorts: [
                {
                  direction: "descending",
                  property: "last_edited_time",
                },
              ],
            });

            let allTasksDbs = response.results.filter((db) =>
              db.title?.[0]?.plain_text.includes("All Notes")
            );
            let nonTaskDbs = response.results.filter(
              (db) => !db.title?.[0]?.plain_text.includes("All Notes")
            );
            let sortedDbs = [...allTasksDbs, ...nonTaskDbs];
            const UTregex = /All Notes/;
            const UTLabel = " – (używane w Ultimate Notes)";
            const UBregex = /All Notes \[\w*\]/;
            const UBLabel = " – (używane w Ultimate Brain)";
            const options = sortedDbs.map((db) => ({
              label: UBregex.test(db.title?.[0]?.plain_text)
                ? db.title?.[0]?.plain_text + UBLabel
                : UTregex.test(db.title?.[0]?.plain_text)
                ? db.title?.[0]?.plain_text + UTLabel
                : db.title?.[0]?.plain_text,
              value: db.id,
            }));

            return {
              context: {
                cursor: response.next_cursor,
              },
              options,
            };
          } catch (error) {
            console.error(error);
            return {
              context: {
                cursor: null,
              },
              options: [],
            };
          }
        } else {
          return {
            options: ["Najpierw połącz swoje konto Notion."],
          };
        }
      },
      reloadProps: true,
    },
    // Wprowadzamy dodatkowy krok konfiguracji, który wymusi wybór tagu przed opcjami podsumowania
    konfiguracja_tagu: {
      type: "boolean",
      label: "Konfiguracja tagu",
      description: "Najpierw skonfiguruj tag notatki i jego wartość poniżej, a następnie ustaw tę opcję na 'true' aby przejść do konfiguracji opcji podsumowania.",
      default: false,
      reloadProps: true,
    },
    usluga_ai: {
      type: "string",
      label: "Usługa AI",
      description: "Wybierz usługę AI. Domyślnie OpenAI.",
      options: ["OpenAI", "Anthropic"],
      default: "OpenAI",
      reloadProps: true,
    },
  },

  async additionalProps() {
    const props = {};
    
    // Próba odczytania zapisanych własnych poleceń
    let savedCustomPrompts = [];
   
    // Opisy opcji podsumowania dla podpowiedzi użytkownika
    const optionsDescriptions = {
      "Podsumowanie": "Zwięzłe streszczenie całej zawartości transkrypcji (ok. 10-15% długości).",
      "Główne punkty": "Lista najważniejszych tematów i kluczowych informacji z nagrania.",
      "Elementy do wykonania": "Lista zadań i czynności do wykonania wspomnianych w nagraniu.",
      "Pytania uzupełniające": "Lista pytań, które pojawiły się lub mogłyby się pojawić w kontekście tematów.",
      "Historie": "Wyodrębnione opowieści, anegdoty i przykłady z nagrania.",
      "Odniesienia": "Lista odwołań do zewnętrznych źródeł, osób, dzieł itp.",
      "Argumenty": "Lista potencjalnych kontrargumentów do głównych tez z nagrania.",
      "Powiązane tematy": "Lista tematów powiązanych, które mogą być interesujące do dalszej eksploracji.",
      "Rozdziały": "Podział nagrania na logiczne sekcje z czasem rozpoczęcia/zakończenia.",
      "Ogólny opis dnia": "Krótkie podsumowanie nastroju i charakteru opisanego dnia.",
      "Kluczowe wydarzenia": "Lista najważniejszych zdarzeń wspomniana w dzienniku.",
      "Osiągnięcia": "Lista sukcesów i ukończonych zadań wspomnianych w dzienniku.",
      "Wyzwania": "Lista trudności i problemów napotkanych danego dnia.",
      "Wnioski": "Kluczowe obserwacje i przemyślenia wynikające z zapisków.",
      "Plan działania": "Konkretne kroki do podjęcia w przyszłości.",
      "Rozwój osobisty": "Opis momentów rozwoju osobistego lub pozytywnego wpływu dnia.",
      "Refleksja": "Krótkie podsumowanie wpływu dnia na życie i cele.",
      "Ocena dnia (1-100)": "Liczba od 1 do 100 określająca ogólną ocenę dnia.",
      "AI rekomendacje": "5 konkretnych, praktycznych rekomendacji na podstawie treści nagrania.",
      "Źródła do przejrzenia": "Sugerowane książki, artykuły, kursy lub narzędzia związane z tematem."
    };
    
    // Dodaj opisy dla własnych poleceń
    savedCustomPrompts.forEach(prompt => {
      optionsDescriptions[prompt] = `Własne polecenie: ${prompt}`;
    });

    // Jeśli mamy bazę danych Notion
    if (this.notion && this.databaseID) {
      try {
        const notion = new Client({
          auth: this.notion.$auth.oauth_access_token,
        });
                
        const database = await notion.databases.retrieve({
          database_id: this.databaseID,
        });
                
        const properties = database.properties;
                
        // Pobierz typy właściwości
        const titleProps = Object.keys(properties).filter(k => properties[k].type === "title");
        const numberProps = Object.keys(properties).filter(k => properties[k].type === "number");
        const selectProps = Object.keys(properties).filter(k => properties[k].type === "select");
        const dateProps = Object.keys(properties).filter(k => properties[k].type === "date");
        const textProps = Object.keys(properties).filter(k => properties[k].type === "rich_text");
        const urlProps = Object.keys(properties).filter(k => properties[k].type === "url");
        const filesProps = Object.keys(properties).filter(k => properties[k].type === "files");
        
        // WŁAŚCIWOŚCI PODSTAWOWE
        props.tytulNotatki = {
          type: "string",
          label: "Tytuł notatki (wymagane)",
          description: `Wybierz właściwość tytułu dla notatek. Domyślnie nazywa się **Name**.`,
          options: titleProps.map(prop => ({ label: prop, value: prop })),
          optional: false,
          reloadProps: true,
        };
                
        if (this.tytulNotatki) {
          props.wartoscTytulu = {
            type: "string",
            label: "Wartość tytułu",
            description: 'Wybierz wartość dla tytułu notatki.',
            options: [
              "Tytuł AI",
              "Nazwa pliku",
              'Oba ("Nazwa pliku – Tytuł AI")',
            ],
            default: "Tytuł AI",
            optional: true,
          };
        }

        // USTAWIENIE TAGU - nawet przed inicjalizacją konfiguracji tagu
        props.wlasciwoscTagu = {
          type: "string",
          label: "Tag notatki",
          description: 'Wybierz właściwość typu Select do tagowania notatki.',
          options: selectProps.map(prop => ({ label: prop, value: prop })),
          optional: true,
          reloadProps: true,
        };
        
        // Jeśli wybrano tag notatki, pobierz wartości
        if (this.wlasciwoscTagu) {
          // Pobierz istniejące opcje z bazy danych
          const existingTagOptions = properties[this.wlasciwoscTagu].select.options.map(option => ({
            label: option.name,
            value: option.name,
          }));
                
          // Domyślne opcje, które zawsze powinny być dostępne
          const defaultTagOptions = [
            { label: "🎙️ Nagranie", value: "🎙️ Nagranie" },
            { label: "📓 Dziennik", value: "📓 Dziennik" }
          ];
                
          // Połącz istniejące opcje z domyślnymi, usuwając duplikaty
          const allTagOptions = [...existingTagOptions];
                
          // Dodaj domyślne opcje, jeśli nie istnieją w bazie
          for (const defaultOption of defaultTagOptions) {
            if (!allTagOptions.some(option => option.value === defaultOption.value)) {
              allTagOptions.push(defaultOption);
            }
          }
                        
          props.wartoscTagu = {
            type: "string",
            label: "Wartość tagu",
            description: "Wybierz wartość dla tagu notatki. Domyślnie dostępne są opcje \"🎙️ Nagranie\" i \"📓 Dziennik\", które automatycznie ustawią odpowiednie opcje podsumowania.",
            options: allTagOptions,
            default: "🎙️ Nagranie",
            optional: true,
            reloadProps: true,
          };
        }
                
        props.ikonaNotatki = {
          type: "string",
          label: "Ikona strony",
          description: "Wybierz emoji jako ikonę strony notatki.",
          options: EMOJI,
          optional: true,
          default: "🎙️",
        };
        
        props.wlasciwoscCzasu = {
          type: "string",
          label: "Czas trwania",
          description: "Wybierz właściwość czasu trwania. Musi być typu Number.",
          options: numberProps.map(prop => ({ label: prop, value: prop })),
          optional: true,
        };
                
        props.wlasciwoscKosztu = {
          type: "string",
          label: "Koszt notatki",
          description: "Wybierz właściwość kosztu. Musi być typu Number.",
          options: numberProps.map(prop => ({ label: prop, value: prop })),
          optional: true,
        };
                
        props.wlasciwoscDaty = {
          type: "string",
          label: "Data notatki",
          description: "Wybierz właściwość daty dla notatki.",
          options: dateProps.map(prop => ({ label: prop, value: prop })),
          optional: true,
        };
                
        props.wlasciwoscLinkuPliku = {
          type: "string",
          label: "Link do pliku",
          description: "Wybierz właściwość URL dla linku do pliku.",
          options: urlProps.map(prop => ({ label: prop, value: prop })),
          optional: true,
        };
        
        // Konta i modele AI w zależności od wybranej usługi
        if (this.usluga_ai === "OpenAI") {
          props.openai = {
            type: "app",
            app: "openai",
            label: "Konto OpenAI",
            description: `**Ważne:** Jeśli korzystasz z darmowego kredytu próbnego OpenAI, Twój klucz API może mieć ograniczenia i nie obsłuży dłuższych plików.`,
          };
                
          // Lista modelów OpenAI
          props.model_chat = {
            type: "string",
            label: "Model ChatGPT",
            description: `Wybierz model. Domyślnie **gpt-3.5-turbo**.`,
            default: "gpt-3.5-turbo",
            options: [
              { label: "GPT-3.5 Turbo", value: "gpt-3.5-turbo" },
              { label: "GPT-4o", value: "gpt-4o" },
              { label: "GPT-4o Mini", value: "gpt-4o-mini" },
              { label: "GPT-4 Turbo", value: "gpt-4-turbo-preview" }
            ],
          };
        } else if (this.usluga_ai === "Anthropic") {
          props.anthropic = {
            type: "app",
            app: "anthropic",
            label: "Konto Anthropic",
            description: "Musisz mieć ustawioną metodę płatności w Anthropic.",
          };
                
          props.model_anthropic = {
            type: "string",
            label: "Model Anthropic",
            description: "Wybierz model Anthropic. Domyślnie claude-3-5-haiku-20241022.",
            default: "claude-3-5-haiku-20241022",
            options: [
              "claude-3-5-haiku-20241022",
              "claude-3-5-sonnet-20241022",
              "claude-3-7-sonnet-20250219",
              "claude-3-sonnet-20240229",
              "claude-3-opus-20240229",
              "claude-3-haiku-20240307"
            ],
          };
        }
        
        props.prompt_whisper = {
          type: "string",
          label: "Prompt Whisper (opcjonalnie)",
          description: `Możesz wpisać prompt, który pomoże modelowi transkrypcji. Domyślnie prompt to "Witaj, witaj na moim wykładzie.", co poprawia interpunkcję.`,
          optional: true,
        };

        props.wlasne_polecenia_ai = {
          type: "string",
          label: "Własne polecenia dla AI (opcjonalnie)",
          description: "Wprowadź własne polecenie dla modelu AI, np. 'Podaj 3 pomysły na...'. Wyniki zostaną dodane jako osobna sekcja.",
          optional: true,
        };
            
        // Co ma znaleźć się na stronie
        props.opcje_meta = {
          type: "string[]",
          label: "Elementy strony",
          description: `Wybierz elementy, które mają zostać dodane do strony Notion.`,
          options: [
            "Callout informacyjny",
            "Spis treści",
            "Dane (koszty)"
          ],
          default: ["Callout informacyjny", "Spis treści", "Dane (koszty)"],
        };
        
        // OPCJE PODSUMOWANIA - ładowane tylko po włączeniu konfiguracji tagu
        if (this.konfiguracja_tagu === true) {
          // Przygotowanie opcji podsumowania
          const allSummaryOptions = [
            "Podsumowanie",
            "Główne punkty",
            "Elementy do wykonania",
            "Pytania uzupełniające",
            "Historie",
            "Odniesienia",
            "Argumenty",
            "Powiązane tematy",
            "Rozdziały",
            "Ogólny opis dnia",
            "Kluczowe wydarzenia",
            "Osiągnięcia",
            "Wyzwania",
            "Wnioski",
            "Plan działania",
            "Rozwój osobisty",
            "Refleksja",
            "Ocena dnia (1-100)",
            "AI rekomendacje",
            "Źródła do przejrzenia",
            ...savedCustomPrompts
          ];

          // Dodaj własne polecenie do opcji podsumowania, jeśli istnieje
          if (this.wlasne_polecenia_ai && this.wlasne_polecenia_ai.trim() !== "" && !allSummaryOptions.includes(this.wlasne_polecenia_ai)) {
            allSummaryOptions.push(this.wlasne_polecenia_ai);
          }

          // Tworzenie opisu z wyjaśnieniami dla każdej opcji
          const optionsDescriptionsText = allSummaryOptions
            .map(option => `- **${option}**: ${optionsDescriptions[option] || ""}`)
            .join("\n");
          
          // Ustawianie domyślnych opcji na podstawie wartości tagu
          let defaultSummaryOptions = ["Podsumowanie"]; // Domyślnie tylko podsumowanie
          
          if (this.wartoscTagu === "🎙️ Nagranie") {
            defaultSummaryOptions = [
              "Podsumowanie", 
              "Główne punkty", 
              "Elementy do wykonania", 
              "Pytania uzupełniające",
              "Historie",
              "Odniesienia",
              "Powiązane tematy",
              "Rozdziały"
            ];
          } else if (this.wartoscTagu === "📓 Dziennik") {
            defaultSummaryOptions = [
              "Ogólny opis dnia",
              "Kluczowe wydarzenia",
              "Osiągnięcia",
              "Wyzwania",
              "Wnioski",
              "Plan działania",
              "Rozwój osobisty",
              "Refleksja",
              "Ocena dnia (1-100)",
              "AI rekomendacje"
            ];
          }

          props.opcje_podsumowania = {
            type: "string[]",
            label: "Opcje podsumowania",
            description: `Wybierz opcje do uwzględnienia w podsumowaniu:

${optionsDescriptionsText}`,
            options: allSummaryOptions,
            default: defaultSummaryOptions,
            optional: false,
          };
        }
        
        // Opcje zaawansowane
        props.opcje_zaawansowane = {
          type: "boolean",
          label: "Opcje zaawansowane",
          description: `Ustaw na **True**, aby włączyć opcje zaawansowane.`,
          default: false,
          optional: true,
          reloadProps: true,
        };
                
        if (this.opcje_zaawansowane === true) {
          // Dodawanie pliku do notatki
          props.dodac_plik = {
            type: "boolean",
            label: "Dodać plik do notatki",
            description: "Dodaj plik audio do właściwości plików w Notion.",
            default: false,
            reloadProps: true,
          };
                        
          if (this.dodac_plik === true) {
            props.wlasciwoscPliku = {
              type: "string",
              label: "Właściwość pliku",
              description: "Wybierz właściwość typu Files dla pliku audio.",
              options: filesProps.map(prop => ({ label: prop, value: prop })),
              optional: true,
            };
                        
            props.plan_notion = {
              type: "string",
              label: "Plan Notion",
              description: "Wybierz plan Notion (wpływa na maksymalny rozmiar pliku).",
              options: [
                "Darmowy (max 4.8MB)",
                "Płatny (max 1GB)"
              ],
              default: "Darmowy (max 4.8MB)",
            };
                        
            // Nazwa pliku tylko jeśli dodajemy plik
            props.wlasciwoscNazwyPliku = {
              type: "string",
              label: "Nazwa pliku",
              description: "Wybierz właściwość tekstu dla nazwy pliku.",
              options: textProps.map(prop => ({ label: prop, value: prop })),
              optional: true,
            };
          }
                        
          // Opcje języka
          props.jezyk_tytulu = {
            type: "string",
            label: "Język tytułu",
            description: "Wybierz język dla tytułu notatki.",
            options: lang.LANGUAGES.map((lang) => ({
              label: lang.label,
              value: lang.value,
            })),
            optional: true,
          };

          props.jezyk_transkrypcji = {
            type: "string",
            label: "Język transkrypcji (opcjonalnie)",
            description: `Wybierz język docelowy dla transkrypcji. Whisper spróbuje przetłumaczyć audio na ten język.
            
Jeśli nie znasz języka pliku, możesz zostawić to pole puste, a Whisper spróbuje wykryć język i zapisać transkrypcję w tym samym języku.`,
            optional: true,
            options: lang.LANGUAGES.map((lang) => ({
              label: lang.label,
              value: lang.value,
            })),
            reloadProps: true,
          };
                        
          props.jezyk_podsumowania = {
            type: "string",
            label: "Język podsumowania",
            description: `Określ język dla treści podsumowania. Model AI spróbuje podsumować transkrypcję w wybranym języku.
            
Jeśli zostawisz to pole puste, model AI użyje tego samego języka co transkrypcja.`,
            optional: true,
            options: lang.LANGUAGES.map((lang) => ({
              label: lang.label,
              value: lang.value,
            })),
            reloadProps: true,
          };
                        
          // Dodaj opcje tłumaczenia tylko gdy wybrano język podsumowania
          if (this.jezyk_podsumowania) {
            props.przetlumacz_transkrypcje = {
              type: "string",
              label: "Dodaj tłumaczenie (transkrypcja)",
              description: `Wybierz opcję tłumaczenia transkrypcji na język wybrany w ustawieniu "Język podsumowania". Opcja będzie miała efekt tylko wtedy, gdy język transkrypcji różni się od języka podsumowania.

**Przetłumacz i zachowaj oryginał**: Doda oryginalną transkrypcję i tłumaczenie.
**Przetłumacz tylko**: Doda tylko tłumaczenie transkrypcji.
**Nie tłumacz**: Zostawi tylko oryginalną transkrypcję.

Tłumaczenie zwiększy koszt o około $0.003 za 1000 słów.`,
              optional: true,
              options: [
                "Przetłumacz i zachowaj oryginał",
                "Przetłumacz tylko",
                "Nie tłumacz"
              ],
              default: "Przetłumacz i zachowaj oryginał",
            };
          }
                        
          // Parametry AI
          props.gestosc_podsumowania = {
            type: "integer",
            label: "Gęstość podsumowania",
            description: `Ustawia maksymalną liczbę tokenów dla każdego fragmentu transkrypcji, a tym samym maksymalną liczbę tokenów w promptach wysyłanych do modelu AI.

Mniejsza liczba spowoduje "gęstsze" podsumowanie, ponieważ ten sam prompt będzie stosowany do mniejszego fragmentu transkrypcji - stąd wykonanych zostanie więcej żądań, gdyż transkrypcja zostanie podzielona na więcej fragmentów.

Umożliwi to obsługę dłuższych plików, ponieważ ten skrypt używa równoległych żądań, a model AI będzie potrzebował mniej czasu na przetworzenie chunka z mniejszą liczbą tokenów.`,
            min: 500,
            max: this.usluga_ai === "Anthropic" ? 50000 : 5000,
            default: 2750,
            optional: true,
          };
                        
          props.szczegolowoc = {
            type: "string",
            label: "Szczegółowość",
            description: `Określa poziom szczegółowości podsumowania i list (które zostały aktywowane) dla każdego fragmentu transkrypcji.

- **Wysoka** - Podsumowanie będzie stanowić 20-25% długości transkrypcji. Większość list będzie ograniczona do 5-10 elementów.
- **Średnia** - Podsumowanie będzie stanowić 10-15% długości transkrypcji. Większość list będzie ograniczona do 3-5 elementów.
- **Niska** - Podsumowanie będzie stanowić 5-10% długości transkrypcji. Większość list będzie ograniczona do 2-3 elementów.`,
            options: ["Niska", "Średnia", "Wysoka"],
            default: "Średnia",
          };
                        
          props.temperatura = {
            type: "integer",
            label: "Temperatura",
            description: `Ustaw temperaturę dla modelu AI. Prawidłowe wartości to liczby całkowite od 0 do 10, które są dzielone przez 10, aby osiągnąć końcową wartość między 0 a 1.0.

Wyższe temperatury mogą skutkować bardziej "kreatywnym" wynikiem, ale zwiększają ryzyko, że wyjście nie będzie prawidłowym JSON.`,
            min: 0,
            max: 10,
            default: 2,
          };
                        
          props.rozmiar_fragmentu = {
            type: "integer",
            label: "Rozmiar fragmentu (MB)",
            description: `Twój plik audio zostanie podzielony na fragmenty przed wysłaniem do transkrypcji. Jest to niezbędne, aby obsłużyć limit rozmiaru pliku.

To ustawienie pozwala na zmniejszenie tych fragmentów - do wartości od 10MB do 50MB. Mniejszy rozmiar fragmentu może umożliwić obsługę dłuższych plików.`,
            min: 10,
            max: 50,
            default: 24,
          };
                        
          props.wylacz_moderacje = {
            type: "boolean",
            label: "Wyłącz moderację",
            description: `Domyślnie ten workflow NIE będzie sprawdzał Twojej transkrypcji pod kątem nieodpowiednich treści za pomocą API Moderacji OpenAI. Jeśli chcesz włączyć to sprawdzanie, ustaw tę opcję na false.`,
            default: false,
          };
                        
          props.przerwij_bez_czasu = {
            type: "boolean",
            label: "Przerwij bez czasu",
            description: "Przerywa, jeśli czas trwania nie może być określony.",
            default: false,
          };
        }
      } catch (error) {
        console.error("Błąd podczas pobierania właściwości bazy danych Notion:", error);
      }
    }
            
    return props;
  },
  
  methods: {
    // Funkcja pomocnicza do naprawy niepoprawnego JSONa
    repairJSON(input) {
      console.log("Typ danych wejściowych:", typeof input);
      
      if (!input || input.trim() === "") {
        console.log("Otrzymano pustą odpowiedź od modelu AI");
        return {
          title: "Transkrypcja audio",
          summary: "Model AI nie zwrócił żadnej odpowiedzi.",
          main_points: ["Brak danych do analizy"],
          action_items: ["Brak danych do analizy"],
          follow_up: ["Brak danych do analizy"]
        };
      }

      let jsonObj;
      try {
        jsonObj = JSON.parse(input);
        console.log("Pomyślnie sparsowano JSON bez naprawy");
        return jsonObj;
      } catch (error) {
        try {
          console.log(`Napotkano błąd: ${error}. Próba naprawy JSON...`);
          const cleanedJsonString = jsonrepair(input);
          console.log("Naprawiony JSON:", cleanedJsonString);
          jsonObj = JSON.parse(cleanedJsonString);
          console.log("Naprawa JSON udana");
          return jsonObj;
        } catch (error) {
          console.log(`Pierwsza próba naprawy nieudana: ${error}. Próbuję alternatywnej metody...`);
          try {
            // Szukanie czegoś co przypomina obiekt JSON
            const jsonPattern = /\{[\s\S]*\}/g;
            const matches = input.match(jsonPattern);

            if (matches && matches.length > 0) {
              console.log("Znaleziono potencjalny obiekt JSON:", matches[0]);
              const cleanedJsonString = jsonrepair(matches[0]);
              console.log("Naprawiony JSON:", cleanedJsonString);
              jsonObj = JSON.parse(cleanedJsonString);
              console.log("Alternatywna naprawa udana");
              return jsonObj;
            } else {
              console.log("Nie znaleziono potencjalnego obiektu JSON, zwracam obiekt awaryjny");
              return {
                title: "Transkrypcja audio",
                summary: "Nie udało się przetworzyć odpowiedzi z modelu AI.",
                main_points: ["Brak danych do analizy"],
                action_items: ["Brak danych do analizy"],
                follow_up: ["Brak danych do analizy"]
              };
            }
          } catch (error) {
            console.error(`Wszystkie próby naprawy JSON nieudane: ${error.message}`);
            return {
              title: "Transkrypcja audio",
              summary: "Wystąpił błąd podczas przetwarzania odpowiedzi od modelu AI.",
              main_points: ["Brak danych do analizy"],
              action_items: ["Brak danych do analizy"],
              follow_up: ["Brak danych do analizy"]
            };
          }
        }
      }
    },
    
    // Sprawdzanie wielkości pliku
    async checkSize(fileSize) {
      if (fileSize > 500000000) {
        throw new Error(`Plik jest zbyt duży. Pliki muszą być mniejsze niż 500MB.`);
      } else {
        const readableFileSize = fileSize / 1000000;
        console.log(`Rozmiar pliku: ${readableFileSize.toFixed(1)}MB.`);
      }
      
      // Jeśli włączona opcja dodawania pliku, sprawdź limit rozmiaru
      if (this.dodac_plik) {
        const maxSize = this.plan_notion === "Darmowy (max 4.8MB)" ? 4.8 * 1000000 : 1000000000;
        if (fileSize > maxSize) {
          throw new Error(`Plik jest zbyt duży dla wybranego planu Notion. Maksymalny rozmiar dla planu ${this.plan_notion} to ${maxSize/1000000}MB.`);
        }
      }
    },
    
    // Ustawianie języków
    setLanguages() {
      if (this.jezyk_transkrypcji) {
        console.log(`Ustawiono język transkrypcji: ${this.jezyk_transkrypcji}`);
        config.transcriptLanguage = this.jezyk_transkrypcji;
      }
      if (this.jezyk_podsumowania) {
        console.log(`Ustawiono język podsumowania: ${this.jezyk_podsumowania}`);
        config.summaryLanguage = this.jezyk_podsumowania;
      }
      if (this.jezyk_tytulu) {
        console.log(`Ustawiono język tytułu: ${this.jezyk_tytulu}`);
        config.titleLanguage = this.jezyk_tytulu;
      }
    },
    
    // Pobieranie pliku do katalogu tymczasowego
    async downloadToTmp(fileLink, filePath, fileName) {
      try {
        const mime = filePath.match(/\.\w+$/)[0];
        if (!config.supportedMimes.includes(mime)) {
          throw new Error(`Nieobsługiwany format pliku. Obsługiwane: ${config.supportedMimes.join(", ")}`);
        }

        const tmpPath = `/tmp/${filePath.match(/[^\/]*\.\w+$/)[0].replace(/[\?$#&\{\}\[\]<>\*!@:\+\\\/]/g, "")}`;
        const pipeline = promisify(stream.pipeline);
        await pipeline(got.stream(fileLink), fs.createWriteStream(tmpPath));

        return {
          file_name: fileName,
          path: tmpPath,
          mime: mime,
        };
      } catch (error) {
        throw new Error(`Nie udało się pobrać pliku: ${error.message}`);
      }
    },
    
    // Czyszczenie plików tymczasowych
    async cleanTmp(cleanChunks = true) {
      console.log(`Czyszczę katalog /tmp/...`);

      if (config.filePath && fs.existsSync(config.filePath)) {
        await fs.promises.unlink(config.filePath);
      }

      if (cleanChunks && config.chunkDir.length > 0 && fs.existsSync(config.chunkDir)) {
        await execAsync(`rm -rf "${config.chunkDir}"`);
      }
    },
  },
  
  async run({ steps, $ }) {
    // Ta część zostanie uzupełniona później, gdy interfejs będzie gotowy
    // Na razie zwracamy tylko podstawowe informacje do testów
    
    return {
      message: "Interfejs skonfigurowany pomyślnie. Reszta funkcjonalności zostanie dodana w następnym kroku.",
      config: {
        databaseID: this.databaseID,
        usluga_ai: this.usluga_ai,
        wartoscTagu: this.wartoscTagu,
        opcje_podsumowania: this.opcje_podsumowania || []
      }
    };
  },
}
