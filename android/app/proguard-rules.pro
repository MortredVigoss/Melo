-keepattributes Signature,InnerClasses,EnclosingMethod
# iCal4j discovers factories via META-INF/services; retain providers, not unused Groovy DSLs.
-keep class * implements net.fortuna.ical4j.model.PropertyFactory { public <init>(...); }
-keep class * implements net.fortuna.ical4j.model.ParameterFactory { public <init>(...); }
-keep class * implements net.fortuna.ical4j.model.ComponentFactory { public <init>(...); }
# Optional compile-time annotations and non-selected integrations are not runtime dependencies.
-dontwarn org.joda.convert.**
-dontwarn groovy.**
-dontwarn org.codehaus.groovy.**
-dontwarn java.beans.Transient
-dontwarn org.jparsec.**
-dontwarn com.github.benmanes.caffeine.**
-dontwarn org.slf4j.impl.**
