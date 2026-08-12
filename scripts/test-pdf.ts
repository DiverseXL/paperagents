import { config } from "dotenv";
config({ path: ".env.local", override: true });

import { runOrchestration } from "../lib/orchestrator";

const OCR_TEXT = `Obafemi Awolowo University, Ile-Ife
Department of Software Engineering
SEN 104 & SEN 214: Introduction to Mobile Application Development
Length Requirement: Each answer must
be comprehensive but concise, averaging
between 250 to 450 words per question.
Do not pad your answers with filler; focus on
technical accuracy, clear justifications, and
relevant code snippets.
Submission Deadline: July 30th, 2026
Theory & Synthesis Assignment Instructions
These questions require deep technical explanations. Do not simply provide definitions. You
must justify your answers, provide code snippets where possible, and demonstrate a practical
understanding of Android architecture and Java logic.
   Submission Link: Click here to access the Google Form and Submit your Assignment
1. The Android Activity Lifecycle and State Retention
Imagine a user is filling out a long registration form in your application. Halfway through,
they receive a phone call, which brings a new screen to the foreground. Explain exactly
which lifecycle methods your Activity goes through. Furthermore, explain the architectural
approach you must take to ensure the user does not lose their typed data when they
return to your app.
2. Layout Architecture: ConstraintLayout vs. LinearLayout
While LinearLayout is intuitive, modern Android development heavily favors
ConstraintLayout. Discuss the performance implications of deeply nested layouts (the
"layout weight" problem). Provide a specific, complex UI scenario where
ConstraintLayout is vastly superior, and explain how it prevents a "flat" view
hierarchy from becoming a performance bottleneck.
3. Implicit vs. Explicit Intent Resolution
Differentiate between Implicit and Explicit Intents. If you write an Implicit Intent to open a
specific website, explain how the Android Operating System uses the
AndroidManifest.xml and intent filters of other applications on the device to
determine which app should handle your request.
4. The Philosophy of Resource Separation
Android enforces a strict separation between UI structure (XML), logical behavior (Java),
and static assets (Strings, Colors, Dimensions). Discuss the long-term software
engineering consequences of "hardcoding" text and dimensions directly into Java or
layout files. How does the R.java file bridge the gap between these separated
resources?
5. Density-Independent Measurement Metrics
Explain the mathematical and functional differences between
px, dp, and sp. A junior developer uses dp for a TextView's text size. Explain why this
is considered a poor practice and how it violates modern mobile accessibility standards.
6. Diagnostic Tracing with Logcat
Your application compiles successfully with zero syntax errors, but the moment the user
clicks a specific button, the app crashes and closes completely. Explain how you would
utilize Logcat to isolate the exact line of code causing the crash. What specific Exception
are you most likely looking for if you forgot to initialize a UI component before using it?
7. ScrollView Limitations and ViewGroups
A ScrollView is architecturally restricted to hosting only a single direct child View.
Explain the logic behind this design constraint. Write an XML snippet demonstrating the
correct way to design a vertically scrolling page that contains three ImageViews and four
TextViews without violating this constraint.
8. Robust Input Handling and Exception Catching
Detail the process of retrieving numeric data from an EditText and casting it to an
Integer for mathematical operations. Write a robust Java code snippet that retrieves user
input, handles cases where the user leaves the field completely blank, and utilizes a
try-catch block to prevent a NumberFormatException from crashing the app.
9. The Role of the Android Manifest
The AndroidManifest.xml is often described as the blueprint of the application.
Beyond simply listing Activities, detail three critical system-level declarations that must be
present in this file for an application that requires internet access and uses a custom
launcher icon.
10. Build Automation with Gradle
Explain the role of Gradle in the Android build ecosystem. Differentiate between the
responsibilities of the
build.gradle (Project)file and the build.gradle (Module: app)file. Where
would you specify the Minimum SDK, and why is this setting critical for your app's
deployment?
11. UI Threading and ANR Prevention
Define an ANR (Application Not Responding) error. What specific software engineering
mistake on the "Main Thread" causes the Android OS to trigger this error? Explain the
architectural pattern a developer must use when writing code that fetches large amounts
of data from the internet to prevent freezing the UI.
12. View Visibility Mechanics
Explain the functional and layout rendering differences between View.INVISIBLE and
View.GONE. Provide a specific user interface design scenario where changing a
component to INVISIBLE would ruin the visual structure of the screen compared to
using GONE.
13. The Concept of "Context" in Android
The Context object is heavily passed around in Android development (e.g., when
creating a Toast or an Intent). Define what Context represents within the Android
Operating System and describe why UI elements need it to render properly.
14. Logical Input Controls: RadioGroup vs. CheckBox
You are building an academic survey application. Define the exact logical conditions and
data collection requirements under which you would be forced to use a RadioGroup
with RadioButtons instead of multiple CheckBoxes. How does the Java logic differ
when verifying which options the user selected?
15. Object-Oriented Principles: Inheritance and Overriding
When creating a new screen, your Java class must extend AppCompatActivity.
Explain the object-oriented significance of this inheritance. Furthermore, explain the
purpose of the @Override annotation above the onCreate method, and describe what
happens to the application if you fail to call super.onCreate(savedInstanceState).`;

async function main() {
  console.log(`Loaded OCR text from PDF: ${OCR_TEXT.length} characters.\n`);

  const query = "Android Mobile Application Development activity lifecycle layouts ConstraintLayout intents";

  console.log(`Running orchestration pipeline...`);
  const report = await runOrchestration(query, OCR_TEXT, (event: any) => {
    console.log(`[${event.agent}] ${event.status}: ${event.message}`);
  });

  console.log("\n========== ANALYSIS REPORT FOR PDF ==========");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error("Failed:", e);
  process.exit(1);
});
